// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDG is ERC20 {
    address public immutable minter;

    constructor() ERC20("Mock Global Dollar", "mUSDG") {
        minter = msg.sender;
        _mint(msg.sender, 1_000_000_000e6);
    }

    function mint(address account, uint256 amount) external {
        require(msg.sender == minter, "MockUSDG: caller is not minter");
        _mint(account, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
