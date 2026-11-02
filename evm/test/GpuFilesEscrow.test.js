import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

describe("GpuFilesEscrow", function () {
  async function deployFixture() {
    const [arbitrator, buyer, provider, other] = await ethers.getSigners();
    const token = await ethers.deployContract("MockUSDG");
    const escrow = await ethers.deployContract("GpuFilesEscrow", [token.target, arbitrator.address]);
    const amount = 25_000_000n;
    await token.mint(buyer.address, amount * 4n);
    await token.connect(buyer).approve(escrow.target, amount * 4n);
    return { arbitrator, buyer, provider, other, token, escrow, amount };
  }

  async function createJob(fixture) {
    const termsHash = ethers.keccak256(ethers.toUtf8Bytes("terms"));
    await fixture.escrow.connect(fixture.buyer).createJob(termsHash, fixture.amount);
    return { termsHash, jobId: 0n };
  }

  it("escrows the exact approved token amount and records the committed terms", async function () {
    const fixture = await deployFixture();
    const { termsHash, jobId } = await createJob(fixture);
    const job = await fixture.escrow.jobs(jobId);

    expect(job.buyer).to.equal(fixture.buyer.address);
    expect(job.amount).to.equal(fixture.amount);
    expect(job.termsHash).to.equal(termsHash);
    expect(job.status).to.equal(0);
    expect(await fixture.token.balanceOf(fixture.escrow.target)).to.equal(fixture.amount);
  });

  it("lets the buyer cancel only before a provider accepts and refunds the full amount", async function () {
    const fixture = await deployFixture();
    await createJob(fixture);
    await fixture.escrow.connect(fixture.buyer).cancelOpenJob(0);

    expect((await fixture.escrow.jobs(0)).status).to.equal(5);
    expect(await fixture.token.balanceOf(fixture.buyer.address)).to.equal(fixture.amount * 4n);
    await expect(fixture.escrow.connect(fixture.buyer).cancelOpenJob(0)).to.be.revertedWithCustomError(fixture.escrow, "InvalidStatus");
  });

  it("blocks buyer self-acceptance and accepts exactly one provider", async function () {
    const fixture = await deployFixture();
    await createJob(fixture);
    await expect(fixture.escrow.connect(fixture.buyer).acceptJob(0)).to.be.revertedWithCustomError(fixture.escrow, "Unauthorized");
    await expect(fixture.escrow.connect(fixture.provider).acceptJob(1)).to.be.revertedWithCustomError(fixture.escrow, "InvalidStatus");

    await fixture.escrow.connect(fixture.provider).acceptJob(0);
    await expect(fixture.escrow.connect(fixture.other).acceptJob(0)).to.be.revertedWithCustomError(fixture.escrow, "InvalidStatus");
  });

  it("pays the provider only when the buyer approves a submitted result", async function () {
    const fixture = await deployFixture();
    await createJob(fixture);
    await fixture.escrow.connect(fixture.provider).acceptJob(0);
    const resultHash = ethers.keccak256(ethers.toUtf8Bytes("result"));
    await fixture.escrow.connect(fixture.provider).submitResult(0, resultHash);
    await expect(fixture.escrow.connect(fixture.other).approveResult(0)).to.be.revertedWithCustomError(fixture.escrow, "Unauthorized");

    await fixture.escrow.connect(fixture.buyer).approveResult(0);
    expect((await fixture.escrow.jobs(0)).status).to.equal(4);
    expect(await fixture.token.balanceOf(fixture.provider.address)).to.equal(fixture.amount);
    expect(await fixture.token.balanceOf(fixture.escrow.target)).to.equal(0);
  });

  it("allows only the configured arbitrator to resolve a dispute", async function () {
    const fixture = await deployFixture();
    await createJob(fixture);
    await fixture.escrow.connect(fixture.provider).acceptJob(0);
    await fixture.escrow.connect(fixture.provider).submitResult(0, ethers.keccak256(ethers.toUtf8Bytes("result")));
    await fixture.escrow.connect(fixture.buyer).raiseDispute(0);
    await expect(fixture.escrow.connect(fixture.other).resolveDispute(0, true)).to.be.revertedWithCustomError(fixture.escrow, "Unauthorized");

    await fixture.escrow.connect(fixture.arbitrator).resolveDispute(0, false);
    expect((await fixture.escrow.jobs(0)).status).to.equal(5);
    expect(await fixture.token.balanceOf(fixture.buyer.address)).to.equal(fixture.amount * 4n);
  });

  it("can resolve a dispute in favor of the provider", async function () {
    const fixture = await deployFixture();
    await createJob(fixture);
    await fixture.escrow.connect(fixture.provider).acceptJob(0);
    await fixture.escrow.connect(fixture.provider).submitResult(0, ethers.keccak256(ethers.toUtf8Bytes("result")));
    await fixture.escrow.connect(fixture.provider).raiseDispute(0);
    await fixture.escrow.connect(fixture.arbitrator).resolveDispute(0, true);

    expect((await fixture.escrow.jobs(0)).status).to.equal(4);
    expect(await fixture.token.balanceOf(fixture.provider.address)).to.equal(fixture.amount);
  });
});
