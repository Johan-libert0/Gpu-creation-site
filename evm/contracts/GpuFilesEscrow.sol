// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract GpuFilesEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        Open,
        Accepted,
        Completed,
        Disputed,
        Paid,
        Refunded
    }

    struct Job {
        address buyer;
        address provider;
        uint256 amount;
        bytes32 termsHash;
        bytes32 resultHash;
        Status status;
    }

    error InvalidAddress();
    error InvalidAmount();
    error InvalidTerms();
    error InvalidStatus();
    error Unauthorized();
    error NonExactTransfer();

    IERC20 public immutable paymentToken;
    address public immutable arbitrator;
    uint256 public nextJobId;
    mapping(uint256 jobId => Job job) public jobs;

    event JobFunded(uint256 indexed jobId, address indexed buyer, uint256 amount, bytes32 termsHash);
    event JobAccepted(uint256 indexed jobId, address indexed provider);
    event ResultSubmitted(uint256 indexed jobId, bytes32 resultHash);
    event DisputeRaised(uint256 indexed jobId, address indexed raisedBy);
    event DisputeResolved(uint256 indexed jobId, bool paidToProvider);
    event PayoutReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event BuyerRefunded(uint256 indexed jobId, address indexed buyer, uint256 amount);

    constructor(IERC20 paymentToken_, address arbitrator_) {
        if (address(paymentToken_) == address(0) || arbitrator_ == address(0)) {
            revert InvalidAddress();
        }
        paymentToken = paymentToken_;
        arbitrator = arbitrator_;
    }

    function createJob(bytes32 termsHash, uint256 amount) external nonReentrant returns (uint256 jobId) {
        if (termsHash == bytes32(0)) revert InvalidTerms();
        if (amount == 0) revert InvalidAmount();

        uint256 balanceBefore = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = paymentToken.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) {
            revert NonExactTransfer();
        }

        jobId = nextJobId++;
        jobs[jobId] = Job({
            buyer: msg.sender,
            provider: address(0),
            amount: amount,
            termsHash: termsHash,
            resultHash: bytes32(0),
            status: Status.Open
        });
        emit JobFunded(jobId, msg.sender, amount, termsHash);
    }

    function acceptJob(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Open || job.buyer == address(0)) revert InvalidStatus();
        if (msg.sender == job.buyer) revert Unauthorized();
        job.provider = msg.sender;
        job.status = Status.Accepted;
        emit JobAccepted(jobId, msg.sender);
    }

    function submitResult(uint256 jobId, bytes32 resultHash) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Accepted) revert InvalidStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        if (resultHash == bytes32(0)) revert InvalidTerms();
        job.resultHash = resultHash;
        job.status = Status.Completed;
        emit ResultSubmitted(jobId, resultHash);
    }

    function approveResult(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != Status.Completed) revert InvalidStatus();
        if (msg.sender != job.buyer) revert Unauthorized();
        _releaseToProvider(jobId, job);
    }

    function cancelOpenJob(uint256 jobId) external nonReentrant {
        Job storage job = jobs[jobId];
        if (job.status != Status.Open) revert InvalidStatus();
        if (msg.sender != job.buyer) revert Unauthorized();
        _refundBuyer(jobId, job);
    }

    function raiseDispute(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Accepted && job.status != Status.Completed) revert InvalidStatus();
        if (msg.sender != job.buyer && msg.sender != job.provider) revert Unauthorized();
        job.status = Status.Disputed;
        emit DisputeRaised(jobId, msg.sender);
    }

    function resolveDispute(uint256 jobId, bool payProvider) external nonReentrant {
        if (msg.sender != arbitrator) revert Unauthorized();
        Job storage job = jobs[jobId];
        if (job.status != Status.Disputed) revert InvalidStatus();
        emit DisputeResolved(jobId, payProvider);
        if (payProvider) {
            _releaseToProvider(jobId, job);
        } else {
            _refundBuyer(jobId, job);
        }
    }

    function _releaseToProvider(uint256 jobId, Job storage job) private {
        job.status = Status.Paid;
        paymentToken.safeTransfer(job.provider, job.amount);
        emit PayoutReleased(jobId, job.provider, job.amount);
    }

    function _refundBuyer(uint256 jobId, Job storage job) private {
        job.status = Status.Refunded;
        paymentToken.safeTransfer(job.buyer, job.amount);
        emit BuyerRefunded(jobId, job.buyer, job.amount);
    }
}
