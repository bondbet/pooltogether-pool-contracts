const { deployContract } = require('ethereum-waffle')
const { deployMockContract } = require('./helpers/deployMockContract')
const BarnPrizePoolHarness = require('../build/BarnPrizePoolHarness.json')
const TokenListenerInterface = require('../build/TokenListenerInterface.json')
const ControlledToken = require('../build/ControlledToken.json')
const BarnFacetMock = require('../build/BarnFacetMock.json')
const BarnBridgeToken = require('../build/BarnBridgeToken.json')

const { ethers } = require('ethers')
const { expect } = require('chai')
const buidler = require('@nomiclabs/buidler')

const toWei = ethers.utils.parseEther

const debug = require('debug')('ptv3:yVaultPrizePool.test')

let overrides = { gasLimit: 20000000 }

describe('BarnPrizePool', function () {
  let wallet, wallet2

  let prizePool, bondToken, barn, prizeStrategy, comptroller

  let poolMaxExitFee = toWei('0.5')
  let poolMaxTimelockDuration = 10000

  let ticket

  let initializeTxPromise

  beforeEach(async () => {
    [wallet, wallet2] = await buidler.ethers.getSigners()
    debug(`using wallet ${wallet._address}`)

    debug('creating token...')
    bondToken = await deployContract(wallet, BarnBridgeToken, [], overrides)

    debug('creating barn...')
    barn = await deployContract(wallet, BarnFacetMock, [bondToken.address], overrides)

    prizeStrategy = await deployMockContract(wallet, TokenListenerInterface.abi, overrides)

    await prizeStrategy.mock.supportsInterface.returns(true)
    await prizeStrategy.mock.supportsInterface.withArgs('0xffffffff').returns(false)


    comptroller = await deployMockContract(wallet, TokenListenerInterface.abi, overrides)

    debug('deploying BarnPrizePoolHarness...')
    prizePool = await deployContract(wallet, BarnPrizePoolHarness, [], overrides)

    ticket = await deployMockContract(wallet, ControlledToken.abi, overrides)
    await ticket.mock.controller.returns(prizePool.address)

    initializeTxPromise = prizePool['initialize(address,address[],uint256,uint256,address)'](
      comptroller.address,
      [ticket.address],
      poolMaxExitFee,
      poolMaxTimelockDuration,
      barn.address
    )

    await initializeTxPromise

    await prizePool.setPrizeStrategy(prizeStrategy.address)
  })

  describe('initialize()', () => {
    it('should initialize the BarnPrizePool', async () => {
      await expect(initializeTxPromise)
        .to.emit(prizePool, 'BarnPrizePoolInitialized')
        .withArgs(
          barn.address
        )

      expect(await prizePool.barn()).to.equal(barn.address)
    })
  })

  describe('_supply()', () => {
    it('should supply funds from the user', async () => {
      let amount = toWei('500')
      await bondToken.mint(prizePool.address, amount)
      await prizePool.supply(amount)
      expect(await bondToken.balanceOf(barn.address)).to.equal(amount)
    })
  })

  describe('_redeem()', () => {
    let amount

    beforeEach(async () => {
      amount = toWei('300')
      await bondToken.mint(prizePool.address, amount)
      await prizePool.supply(amount)
    })

    it('should revert if reserve is exceeded', async () => {
      await expect(prizePool.redeem(amount + toWei('1'))).to.be.revertedWith("BarnPrizePool/insuff-liquidity")
    })

    it('should allow a user to withdraw', async () => {
      expect(await prizePool.callStatic.redeem(toWei('100'))).to.equal(toWei('100'))
      await prizePool.redeem(toWei('100'))
      expect(await bondToken.balanceOf(prizePool.address)).to.equal(toWei('100'))
      expect(await bondToken.balanceOf(barn.address)).to.equal(toWei('200'))
    })

    it('should not allow user to withdraw if bond is locked', async () => {
      await expect(prizePool.redeem(amount)).to.be.revertedWith("BarnPrizePool/insuff-liquidity")
    })

  })

  describe('balance()', () => {
    it('should return zero when nothing', async () => {
      expect(await prizePool.callStatic.balance()).to.equal(toWei('0'))
    })


    it('should return the balance of the pool', async () => {
      let amount = toWei('100')

      await bondToken.mint(prizePool.address, amount)
      await prizePool.supply(amount)

      expect(await prizePool.callStatic.balance()).to.equal(toWei('100'))

      await bondToken.mint(barn.address, amount)

      expect(await prizePool.callStatic.balance()).to.equal(toWei('100'))
    })
  })

  describe('_token()', () => {
    it('should return the underlying token', async () => {
      expect(await prizePool.token()).to.equal(bondToken.address)
    })
  })
})
