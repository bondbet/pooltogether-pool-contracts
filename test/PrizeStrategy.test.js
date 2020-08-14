const { deployContract } = require('ethereum-waffle')
const { deployMockContract } = require('./helpers/deployMockContract')
const { call, callRaw } = require('./helpers/call')
const { deploy1820 } = require('deploy-eip-1820')
const  ComptrollerInterface = require('../build/ComptrollerInterface.json')
const PrizeStrategyHarness = require('../build/PrizeStrategyHarness.json')
const PrizePool = require('../build/PrizePool.json')
const RNGInterface = require('../build/RNGInterface.json')
const IERC20 = require('../build/IERC20.json')
const IERC721 = require('../build/IERC721.json')
const ControlledToken = require('../build/ControlledToken.json')

const { expect } = require('chai')
const buidler = require('./helpers/buidler')
const { AddressZero, Zero } = require('ethers/constants')
const toWei = (val) => ethers.utils.parseEther('' + val)
const debug = require('debug')('ptv3:PeriodicPrizePool.test')

const FORWARDER = '0x5f48a3371df0F8077EC741Cc2eB31c84a4Ce332a'

let overrides = { gasLimit: 20000000 }

describe('PrizeStrategy', function() {
  let wallet, wallet2

  let externalERC20Award, externalERC721Award

  let registry, comptroller, prizePool, prizeStrategy, token

  let ticket, sponsorship, rng

  let prizePeriodSeconds = 1000

  let exitFeeMantissa = 0.1
  let creditRateMantissa = exitFeeMantissa / prizePeriodSeconds

  const invalidExternalToken = '0x0000000000000000000000000000000000000001'

  beforeEach(async () => {
    [wallet, wallet2] = await buidler.ethers.getSigners()

    debug(`using wallet ${wallet._address}`)

    debug('deploying registry...')
    registry = await deploy1820(wallet)

    debug('deploying protocol comptroller...')
    comptroller = await deployMockContract(wallet, ComptrollerInterface.abi, [], overrides)

    debug('mocking tokens...')
    token = await deployMockContract(wallet, IERC20.abi, overrides)
    prizePool = await deployMockContract(wallet, PrizePool.abi, overrides)
    ticket = await deployMockContract(wallet, ControlledToken.abi, overrides)
    sponsorship = await deployMockContract(wallet, ControlledToken.abi, overrides)
    rng = await deployMockContract(wallet, RNGInterface.abi, overrides)
    externalERC20Award = await deployMockContract(wallet, IERC20.abi, overrides)
    externalERC721Award = await deployMockContract(wallet, IERC721.abi, overrides)

    debug('deploying prizeStrategy...')
    prizeStrategy = await deployContract(wallet, PrizeStrategyHarness, [], overrides)

    await prizePool.mock.canAwardExternal.withArgs(externalERC20Award.address).returns(true)
    await prizePool.mock.canAwardExternal.withArgs(externalERC721Award.address).returns(true)

    debug('initializing prizeStrategy...')
    await prizeStrategy.initialize(
      FORWARDER,
      comptroller.address,
      prizePeriodSeconds,
      prizePool.address,
      ticket.address,
      sponsorship.address,
      rng.address,
      [externalERC20Award.address]
    )

    await prizeStrategy.setExitFeeMantissa(
      toWei(exitFeeMantissa)
    )

    await prizeStrategy.setCreditRateMantissa(
      toWei(creditRateMantissa)
    )

    debug('initialized!')
  })

  describe('initialize()', () => {
    it('should set the params', async () => {
      expect(await prizeStrategy.isTrustedForwarder(FORWARDER)).to.equal(true)
      expect(await prizeStrategy.comptroller()).to.equal(comptroller.address)
      expect(await prizeStrategy.prizePool()).to.equal(prizePool.address)
      expect(await prizeStrategy.prizePeriodSeconds()).to.equal(prizePeriodSeconds)
      expect(await prizeStrategy.ticket()).to.equal(ticket.address)
      expect(await prizeStrategy.sponsorship()).to.equal(sponsorship.address)
      expect(await prizeStrategy.rng()).to.equal(rng.address)
    })

    it('should disallow unapproved external prize tokens', async () => {
      const initArgs = [
        FORWARDER,
        comptroller.address,
        prizePeriodSeconds,
        prizePool.address,
        ticket.address,
        sponsorship.address,
        rng.address,
        [invalidExternalToken]
      ]

      debug('deploying secondary prizeStrategy...')
      const prizeStrategy2 = await deployContract(wallet, PrizeStrategyHarness, [], overrides)

      debug('initializing secondary prizeStrategy...')
      await prizePool.mock.canAwardExternal.withArgs(invalidExternalToken).returns(false)
      await expect(prizeStrategy2.initialize(...initArgs))
        .to.be.revertedWith('PrizeStrategy/cannot-award-external')
    })
  })

  describe('currentPrize()', () => {
    it('should return the currently accrued interest when reserve is zero', async () => {
      await prizePool.mock.awardBalance.returns('100')
      await comptroller.mock.reserveRateMantissa.returns(Zero)
      expect(await call(prizeStrategy, 'currentPrize')).equal('100')
    })

    it('should return the interest accrued less the reserve when the reserve is non-zero', async () => {
      await prizePool.mock.awardBalance.returns('100')
      await comptroller.mock.reserveRateMantissa.returns(toWei('0.1'))
      expect(await call(prizeStrategy, 'currentPrize')).equal('90')
    })
  })

  describe('estimatePrize()', () => {
    it('should calculate the estimated prize', async () => {
      await prizeStrategy.setCurrentTime(await prizeStrategy.prizePeriodStartedAt())
      await prizePool.mock.awardBalance.returns('100')
      await prizePool.mock.accountedBalance.returns('1000')
      await comptroller.mock.reserveRateMantissa.returns(Zero)
      await prizePool.mock.estimateAccruedInterestOverBlocks
        .returns('10')

      expect(await call(prizeStrategy, 'estimatePrize')).to.equal('110')
    })
  })

  describe('setCreditRateMantissa', () => {
    it('should only allow the owner to change it', async () => {
      await expect(prizeStrategy.setCreditRateMantissa(toWei('0.1')))
        .to.emit(prizeStrategy, 'CreditRateUpdated')
        .withArgs(toWei('0.1'))
    })

    it('should not allow anyone but the owner to change', async () => {
      prizeStrategy2 = prizeStrategy.connect(wallet2)
      await expect(prizeStrategy2.setCreditRateMantissa(toWei('0.1'))).to.be.revertedWith('Ownable: caller is not the owner')
    })
  })

  describe('setExitFeeMantissa', () => {
    it('should only allow the owner to change it', async () => {
      await expect(prizeStrategy.setExitFeeMantissa(toWei('0.1')))
        .to.emit(prizeStrategy, 'ExitFeeUpdated')
        .withArgs(toWei('0.1'))
    })

    it('should not allow anyone but the owner to change', async () => {
      prizeStrategy2 = prizeStrategy.connect(wallet2)
      await expect(prizeStrategy2.setExitFeeMantissa(toWei('0.1'))).to.be.revertedWith('Ownable: caller is not the owner')
    })
  })

  describe('setRngService', () => {
    it('should only allow the owner to change it', async () => {
      await expect(prizeStrategy.setRngService(token.address))
        .to.emit(prizeStrategy, 'RngServiceUpdated')
        .withArgs(token.address)
    })

    it('should not allow anyone but the owner to change', async () => {
      prizeStrategy2 = prizeStrategy.connect(wallet2)
      await expect(prizeStrategy2.setRngService(token.address)).to.be.revertedWith('Ownable: caller is not the owner')
    })
  })

  describe('estimatePrizeWithBlockTime()', () => {
    it('should calculate the estimated prize', async () => {
      await prizeStrategy.setCurrentTime(await prizeStrategy.prizePeriodStartedAt())
      await prizePool.mock.awardBalance.returns('100')
      await prizePool.mock.accountedBalance.returns('1000')
      await comptroller.mock.reserveRateMantissa.returns(Zero)
      await prizePool.mock.estimateAccruedInterestOverBlocks
        .withArgs('1000', toWei('10'))
        .returns('10')

      expect(await call(prizeStrategy, 'estimatePrizeWithBlockTime', 100)).to.equal('110')
    })
  })

  describe('calculateInstantWithdrawalFee()', () => {
    it('should calculate fee for instant withdrawal with no credit', async () => {
      const withdrawalAmount = 50
      const exitFee = withdrawalAmount * exitFeeMantissa
      await ticket.mock.balanceOf.withArgs(wallet._address).returns(toWei('100'))

      expect(await call(prizeStrategy, 'balanceOfCredit', wallet._address)).to.equal('0')

      let fees = await callRaw(prizeStrategy, 'calculateInstantWithdrawalFee', wallet._address, toWei(withdrawalAmount), ticket.address)
      expect(fees.remainingFee).to.equal(toWei(exitFee))
      expect(fees.burnedCredit).to.equal('0')
    })
  })

  describe('calculateTimelockDurationAndFee()', () => {
    it('should calculate timelock duration for scheduled withdrawals with no credit', async () => {
      await ticket.mock.balanceOf.withArgs(wallet._address).returns(toWei('100'))

      expect(await call(prizeStrategy, 'balanceOfCredit', wallet._address)).to.equal('0')

      let fees = await callRaw(prizeStrategy, 'calculateTimelockDurationAndFee', wallet._address, toWei('50'), ticket.address)
      expect(fees.durationSeconds).to.equal('' + prizePeriodSeconds)
      expect(fees.burnedCredit).to.equal('0')
    })
  })

  describe('chanceOf()', () => {
    it('should show the odds for a user to win the prize', async () => {
      const amount = toWei('10')
      await ticket.mock.balanceOf.withArgs(wallet._address).returns(amount)
      await ticket.mock.totalSupply.returns(amount)
      await comptroller.mock.afterDepositTo
        .withArgs(wallet._address, amount, amount, amount, ticket.address, AddressZero)
        .returns()
      await prizePool.call(prizeStrategy, 'afterDepositTo', wallet._address, amount, ticket.address, [])
      expect(await prizeStrategy.chanceOf(wallet._address)).to.be.equal(amount)
    })
  })

  describe('afterDepositTo()', () => {
    it('should only be called by the prize pool', async () => {
      prizeStrategy2 = await prizeStrategy.connect(wallet2)
      await expect(prizeStrategy2.afterDepositTo(wallet._address, toWei('10'), ticket.address, [])).to.be.revertedWith('PrizeStrategy/only-prize-pool')
    })

    it('should update the users ticket balance', async () => {
      await ticket.mock.totalSupply.returns(toWei('22'))
      await ticket.mock.balanceOf.withArgs(wallet._address).returns(toWei('22'))
      await comptroller.mock.afterDepositTo.returns()
      await prizePool.call(prizeStrategy, 'afterDepositTo', wallet._address, toWei('10'), ticket.address, [])
      expect(await prizeStrategy.draw(1)).to.equal(wallet._address) // they exist in the sortition sum tree
    })

    it('should not be called if an rng request is in flight', async () => {
      await rng.mock.requestRandomNumber.returns('11', '1');
      await prizeStrategy.setCurrentTime(await prizeStrategy.prizePeriodEndAt());
      await prizeStrategy.startAward();

      await expect(prizePool.call(prizeStrategy, 'afterDepositTo', wallet._address, toWei('10'), ticket.address, []))
        .to.be.revertedWith('PrizeStrategy/rng-in-flight');
    });
  });

  describe('afterWithdrawInstantlyFrom()', () => {
    it('should revert if rng request is in flight', async () => {
      await rng.mock.requestRandomNumber.returns('11', '1');
      await prizeStrategy.setCurrentTime(await prizeStrategy.prizePeriodEndAt());
      await prizeStrategy.startAward();

      await expect(
        prizePool.call(
          prizeStrategy,
          'afterWithdrawInstantlyFrom',
          wallet._address,
          wallet._address,
          toWei('10'),
          ticket.address,
          toWei('0'),
          toWei('0'),
          []
        ))
        .to.be.revertedWith('PrizeStrategy/rng-in-flight')
    });
  });

  describe("beforeTokenTransfer()", () => {
    it('should allow other token transfers if awarding is happening', async () => {
      await rng.mock.requestRandomNumber.returns('11', '1');
      await prizeStrategy.setCurrentTime(await prizeStrategy.prizePeriodEndAt());
      await prizeStrategy.startAward();

      await prizePool.call(
        prizeStrategy,
        'beforeTokenTransfer(address,address,uint256,address)',
        wallet._address,
        wallet._address,
        toWei('10'),
        wallet._address
      )
    })

    it('should revert on ticket transfer if awarding is happening', async () => {
      await rng.mock.requestRandomNumber.returns('11', '1');
      await prizeStrategy.setCurrentTime(await prizeStrategy.prizePeriodEndAt());
      await prizeStrategy.startAward();

      await expect(
        prizePool.call(
          prizeStrategy,
          'beforeTokenTransfer(address,address,uint256,address)',
          wallet._address,
          wallet._address,
          toWei('10'),
          ticket.address
        ))
        .to.be.revertedWith('PrizeStrategy/rng-in-flight')
    })
  })

  describe("afterWithdrawWithTimelockFrom()", () => {
    it('should revert on ticket transfer if awarding is happening', async () => {
      await rng.mock.requestRandomNumber.returns('11', '1');
      await prizeStrategy.setCurrentTime(await prizeStrategy.prizePeriodEndAt());
      await prizeStrategy.startAward();

      await expect(
        prizePool.call(
          prizeStrategy,
          'afterWithdrawWithTimelockFrom(address,uint256,address,bytes)',
          wallet._address,
          toWei('10'),
          ticket.address,
          []
        ))
        .to.be.revertedWith('PrizeStrategy/rng-in-flight')
    })
  })

  describe('estimateCreditAccrualTime()', () => {
    it('should calculate the accrual time', async () => {
      let ticketBalance = toWei('100')
      let interest = toWei('10')
      expect(await prizeStrategy.estimateCreditAccrualTime(
        ticketBalance,
        interest
      )).to.equal(prizePeriodSeconds)
    })

    it('should calculate the accrual time', async () => {
      let ticketBalance = toWei('100')
      let interest = toWei('30')
      expect(await prizeStrategy.estimateCreditAccrualTime(
        ticketBalance,
        interest
      )).to.equal(prizePeriodSeconds * 3)
    })
  })

  describe('addExternalErc20Award()', () => {
    it('should allow the owner to add external ERC20 tokens to the prize', async () => {
      await expect(prizeStrategy.addExternalErc20Award(externalERC20Award.address))
        .to.not.be.revertedWith('PrizeStrategy/cannot-award-external')
    })

    it('should disallow unapproved external ERC20 prize tokens', async () => {
      await prizePool.mock.canAwardExternal.withArgs(invalidExternalToken).returns(false)
      await expect(prizeStrategy.addExternalErc20Award(invalidExternalToken))
        .to.be.revertedWith('PrizeStrategy/cannot-award-external')
    })
  })

  describe('addExternalErc721Award()', () => {
    it('should allow the owner to add external ERC721 tokens to the prize', async () => {
      await externalERC721Award.mock.ownerOf.withArgs(1).returns(prizePool.address)
      await expect(prizeStrategy.addExternalErc721Award(externalERC721Award.address, [1]))
        .to.not.be.revertedWith('PrizeStrategy/unavailable-token')
    })

    it('should disallow unapproved external ERC721 prize tokens', async () => {
      await prizePool.mock.canAwardExternal.withArgs(invalidExternalToken).returns(false)
      await expect(prizeStrategy.addExternalErc721Award(invalidExternalToken, [1]))
        .to.be.revertedWith('PrizeStrategy/cannot-award-external')
    })

    it('should disallow ERC721 tokens that are not held by the Prize Pool', async () => {
      await externalERC721Award.mock.ownerOf.withArgs(1).returns(wallet._address)
      await expect(prizeStrategy.addExternalErc721Award(externalERC721Award.address, [1]))
        .to.be.revertedWith('PrizeStrategy/unavailable-token')
    })
  })

  describe('completeAward()', () => {
    it('should accrue credit to the winner', async () => {
      debug('Setting time')

      await prizeStrategy.setCurrentTime(await prizeStrategy.prizePeriodStartedAt());

      // no external award
      await externalERC20Award.mock.balanceOf.withArgs(prizePool.address).returns('0')

      debug('Calling afterDepositTo')
      await ticket.mock.balanceOf.returns(toWei('10'))
      await ticket.mock.totalSupply.returns(toWei('10'))
      await comptroller.mock.afterDepositTo.returns()

      // have the mock update the number of prize tickets
      await prizePool.call(prizeStrategy, 'afterDepositTo', wallet._address, toWei('10'), ticket.address, []);

      // ensure prize period is over
      await prizeStrategy.setCurrentTime(await prizeStrategy.prizePeriodEndAt());

      // allow an rng request
      await rng.mock.requestRandomNumber.returns('1', '1')

      debug('Starting award...')

      // start the award
      await prizeStrategy.startAward()

      // rng is done
      await rng.mock.isRequestComplete.returns(true)
      await rng.mock.randomNumber.returns('0x6c00000000000000000000000000000000000000000000000000000000000000')
      // draw winner
      await ticket.mock.totalSupply.returns(toWei('10'))

      // 1 dai to give
      await prizePool.mock.awardBalance.returns(toWei('1'))

      // no reserve
      await comptroller.mock.reserveRateMantissa.returns(Zero) // no reserve

      await prizePool.mock.award.withArgs(wallet._address, toWei('1'), ticket.address).returns()

      debug('Completing award...')

      let startedAt = await prizeStrategy.prizePeriodStartedAt();

      // complete the award
      await prizeStrategy.completeAward()

      // ensure new balance is correct
      await ticket.mock.balanceOf.returns(toWei('11'))

      expect(await prizeStrategy.prizePeriodStartedAt()).to.equal(startedAt.add(prizePeriodSeconds))

      expect(await call(prizeStrategy, 'balanceOfCredit', wallet._address)).to.equal(toWei('1.1'))

    })
  })

  describe('calculateNextPrizePeriodStartTime()', () => {
    it('should always sync to the last period start time', async () => {
      let startedAt = await prizeStrategy.prizePeriodStartedAt();
      expect(await prizeStrategy.calculateNextPrizePeriodStartTime(startedAt.add(prizePeriodSeconds * 14))).to.equal(startedAt.add(prizePeriodSeconds * 14))
    })

    it('should return the current if it is within', async () => {
      let startedAt = await prizeStrategy.prizePeriodStartedAt();
      expect(await prizeStrategy.calculateNextPrizePeriodStartTime(startedAt.add(prizePeriodSeconds / 2))).to.equal(startedAt)
    })

    it('should return the next if it is after', async () => {
      let startedAt = await prizeStrategy.prizePeriodStartedAt();
      expect(await prizeStrategy.calculateNextPrizePeriodStartTime(startedAt.add(parseInt(prizePeriodSeconds * 1.5)))).to.equal(startedAt.add(prizePeriodSeconds))
    })
  })
});