import algosdk from 'algosdk'
import * as fs from 'fs'

const server = 'http://localhost'
const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const algodClient = new algosdk.Algodv2(token, server, 4001)
const kmdClient = new algosdk.Kmd(token, server, 4002)
const kmdWallet = 'unencrypted-default-wallet'
const kmdPassword = ''

const firstBidAmount = 111_111
const secondBidAmount = 222_222

// Based on https://github.com/algorand-devrel/demo-abi/blob/master/js/sandbox.ts
async function getAccounts (): Promise<algosdk.Account[]> {
  const wallets = await kmdClient.listWallets()

  // find kmdWallet
  let walletId
  for (const wallet of wallets.wallets) {
    if (wallet.name === kmdWallet) walletId = wallet.id
  }
  if (walletId === undefined) throw Error('No wallet named: ' + kmdWallet)

  // get handle
  const handleResp = await kmdClient.initWalletHandle(walletId, kmdPassword)
  const handle = handleResp.wallet_handle_token

  // get account keys
  const addresses = await kmdClient.listKeys(handle)
  const acctPromises = []
  for (const addr of addresses.addresses) {
    acctPromises.push(kmdClient.exportKey(handle, kmdPassword, addr))
  }
  const keys = await Promise.all(acctPromises)

  // release handle
  kmdClient.releaseWalletHandle(handle)

  // return all algosdk.Account objects derived from kmdWallet
  return keys.map((k) => {
    const addr = algosdk.encodeAddress(k.private_key.slice(32))
    const acct = { sk: k.private_key, addr: addr } as algosdk.Account
    return acct
  })
}

// https://developer.algorand.org/docs/get-details/dapps/smart-contracts/frontend/apps/#create
async function compileProgram (programSource: string) {
  const encoder = new TextEncoder()
  const programBytes = encoder.encode(programSource)
  const compileResponse = await algodClient.compile(programBytes).do()
  const compiledBytes = new Uint8Array(Buffer.from(compileResponse.result, 'base64'))
  return compiledBytes
}

interface GlobalStateDeltaValue {
    action: number,
    bytes?: string
    uint?: number
}

interface GlobalStateDelta {
    key: string
    value: GlobalStateDeltaValue
}

interface ReadableGlobalStateDelta {
    [key: string]: string | number | bigint | undefined
}

function getReadableGlobalState (delta: Array<GlobalStateDelta>) {
  const r = {} as ReadableGlobalStateDelta

  delta.forEach(d => {
    const key = Buffer.from(d.key, 'base64').toString('utf8')
    let value = null

    if (d.value.bytes) {
      // first see if it's a valid address
      const b = new Uint8Array(Buffer.from(d.value.bytes as string, 'base64'))
      value = algosdk.encodeAddress(b)

      // then decode as string
      if (!algosdk.isValidAddress(value)) {
        value = Buffer.from(d.value.bytes as string, 'base64').toString()
      }
    } else {
      value = d.value.uint
    }

    r[key] = value
  })

  return r
}

async function fundAccount (from: algosdk.Account, to: algosdk.Account, amount: number) {
  const payObj = {
    suggestedParams: await algodClient.getTransactionParams().do(),
    from: from.addr,
    to: to.addr,
    amount: amount
  }

  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject(payObj).signTxn(from.sk)
  const { txId } = await algodClient.sendRawTransaction(txn).do()
  await algosdk.waitForConfirmation(algodClient, txId, 3)
}

async function closeAccount (accountToClose: algosdk.Account, closeTo: algosdk.Account) {
  const txnObj = {
    suggestedParams: await algodClient.getTransactionParams().do(),
    from: accountToClose.addr,
    to: accountToClose.addr,
    amount: 0,
    closeTo: closeTo
  }

  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject(txnObj).signTxn(accountToClose.sk)
  const { txId } = await algodClient.sendRawTransaction(txn).do()
  await algosdk.waitForConfirmation(algodClient, txId, 3)
}

async function createAppTxn (creator: algosdk.Account) {
  const approval = await compileProgram(fs.readFileSync('approval.teal').toString())
  const clear = await compileProgram(fs.readFileSync('clear.teal').toString())

  const appObj = {
    suggestedParams: await algodClient.getTransactionParams().do(),
    from: creator.addr,
    numGlobalByteSlices: 2,
    numGlobalInts: 2,
    approvalProgram: approval,
    clearProgram: clear,
  } as any

  return algosdk.makeApplicationCreateTxnFromObject(appObj).signTxn(creator.sk)
}

async function createDryRunFromTxns (txns: Array<Uint8Array>, desc: string, timestamp?: number) {
  const dTxns = txns.map(t => algosdk.decodeSignedTransaction(t))
  const dr = await algosdk.createDryrun({ client: algodClient, txns: dTxns, latestTimestamp: timestamp || 1 })
  fs.writeFileSync('./dryruns/' + desc + '.dr', algosdk.encodeObj(dr.get_obj_for_encoding(true)))
  return dr
}

async function sendTxn (txn: Uint8Array | Array<Uint8Array>) {
  const { txId } = await algodClient.sendRawTransaction(txn).do()
  return await algosdk.waitForConfirmation(algodClient, txId, 3)
}

describe('App Creation', () => {
  let funder: algosdk.Account
  let creator: algosdk.Account
  let globalState: ReadableGlobalStateDelta
  let rawGlobalState: Array<GlobalStateDelta>
  const globalSchema = { ints: 2, bytes: 2 }

  beforeAll(async () => {
    const accounts = await getAccounts()
    funder = accounts[0]

    // create a new account to avoid app creation limit
    creator = algosdk.generateAccount()
    await fundAccount(funder, creator, 10_000_000)

    const appTxn = await createAppTxn(creator)
    const appDr = await createDryRunFromTxns([appTxn], 'app_create')
    const appDrRes = await algodClient.dryrun(appDr).do()
    rawGlobalState = appDrRes.txns[0]['global-delta']

    globalState = getReadableGlobalState(appDrRes.txns[0]['global-delta'])
  })

  it('Global state schema is properly set', () => {
    let ints = 0
    let bytes = 0

    rawGlobalState.forEach(g => {
      if ('uint' in g.value) {
        ints += 1
      } else if ('bytes' in g.value) {
        bytes += 1
      }
    })

    expect(ints).toBe(globalSchema.ints)
    expect(bytes).toBe(globalSchema.bytes)
  })

  it('Global[owner] == creator address', () => {
    expect(globalState.owner).toBe(creator.addr)
  })

  it('Global[auctionEnd] == 0', () => {
    expect(globalState.auctionEnd).toBe(0)
  })

  it('Global[highestBidder] == undefined', () => {
    expect(globalState.highestBidder).toBe(undefined)
  })

  it('Global[highestBid] == undefined', () => {
    expect(globalState.highestBid).toBe(0)
  })

  afterAll(async () => {
    await closeAccount(creator, funder)
  })
})

async function startAuctionTxns (id: number, from: algosdk.Account, startPrice: number, auctionLength: number) {
  const suggestedParams = await algodClient.getTransactionParams().do()

  const appObj = {
    suggestedParams: { ...suggestedParams },
    from: from.addr,
    appIndex: id,
    appArgs: [
      new Uint8Array(Buffer.from('start_auction')),
      algosdk.encodeUint64(startPrice),
      algosdk.encodeUint64(auctionLength)
    ]
  } as any

  const payObj = {
    suggestedParams: { ...suggestedParams },
    from: from.addr,
    to: algosdk.getApplicationAddress(id),
    amount: 100_000
  } as any

  const txns = [] as Array<algosdk.Transaction>

  txns.push(algosdk.makeApplicationCallTxnFromObject(appObj))
  txns.push(algosdk.makePaymentTxnWithSuggestedParamsFromObject(payObj))

  const gTxn = algosdk.assignGroupID(txns)

  const signedTxns = gTxn.map(t => t.signTxn(from.sk))

  return signedTxns
}

describe('Auction Start', () => {
  let funder: algosdk.Account
  let creator: algosdk.Account
  let globalDelta: ReadableGlobalStateDelta

  beforeAll(async () => {
    const accounts = await getAccounts()
    funder = accounts[0]

    // create a new account to avoid app creation limit
    creator = algosdk.generateAccount()
    await fundAccount(funder, creator, 10_000_000)

    const appTxn = await createAppTxn(creator)
    const createResult = await sendTxn(appTxn)

    const appID = createResult['application-index']

    const auctionStartTxns = await startAuctionTxns(appID, creator, 100_000, 3_600)
    const auctionStartDr = await createDryRunFromTxns(auctionStartTxns, 'auction_start')

    const auctionStartDrResult = await algodClient.dryrun(auctionStartDr).do()

    globalDelta = getReadableGlobalState(auctionStartDrResult.txns[0]['global-delta'])
  })

  it('Global delta size == 2', () => {
    expect(Object.keys(globalDelta).length).toBe(2)
  })

  it('Global[highestBid] == starting amount', () => {
    expect(globalDelta.highestBid).toBe(100_000)
  })

  it('Global[auctionEnd] == latestTimestamp + auction length', () => {
    expect(globalDelta.auctionEnd).toBe(3_601)
  })

  afterAll(async () => {
    await closeAccount(creator, funder)
  })
})

async function getBidTxns (id: number, from: algosdk.Account, bid: number) {
  const appAddr = algosdk.getApplicationAddress(id)

  const suggestedParams = await algodClient.getTransactionParams().do()

  const accounts = [] as Array<string>
  const gState = getReadableGlobalState((await algodClient.getApplicationByID(id).do()).params['global-state'])
  const highestBidder = gState.highestBidder

  if (highestBidder) {
    accounts.push(highestBidder as string)
  }

  const appObj = {
    suggestedParams: { ...suggestedParams },
    from: from.addr,
    appIndex: id,
    appArgs: [
      new Uint8Array(Buffer.from('bid'))
    ],
    accounts: accounts
  } as any

  const payObj = {
    suggestedParams: { ...suggestedParams },
    from: from.addr,
    to: appAddr,
    amount: bid
  } as any

  const txns = [] as Array<algosdk.Transaction>
  txns.push(algosdk.makeApplicationCallTxnFromObject(appObj))
  txns.push(algosdk.makePaymentTxnWithSuggestedParamsFromObject(payObj))

  const gTxn = algosdk.assignGroupID(txns)

  return gTxn.map(t => t.signTxn(from.sk))
}

describe('First Bid', () => {
  let funder: algosdk.Account
  let creator: algosdk.Account
  let bidder: algosdk.Account
  let globalDelta: ReadableGlobalStateDelta

  beforeAll(async () => {
    const accounts = await getAccounts()
    funder = accounts[0]

    // create a new account to avoid app creation limit
    creator = algosdk.generateAccount()
    await fundAccount(funder, creator, 10_000_000)

    const appTxn = await createAppTxn(creator)
    const createResult = await sendTxn(appTxn)

    const appID = createResult['application-index']

    const auctionStartTxns = await startAuctionTxns(appID, creator, 100_000, 3_600)
    await sendTxn(auctionStartTxns)

    bidder = algosdk.generateAccount()
    await fundAccount(funder, bidder, 10_000_000)

    const bidTxns = await getBidTxns(appID, bidder, firstBidAmount)
    const bidDr = await createDryRunFromTxns(bidTxns, 'first_bid')

    const bidDrResult = await algodClient.dryrun(bidDr).do()

    globalDelta = getReadableGlobalState(bidDrResult.txns[0]['global-delta'])
  })

  it('Global state delta == two', () => {
    expect(Object.keys(globalDelta).length).toBe(2)
  })

  it('highestBid == bid amount', () => {
    expect(globalDelta.highestBid).toBe(firstBidAmount)
  })

  it('highestBidder == bidder address', () => {
    expect(globalDelta.highestBidder).toBe(bidder.addr)
  })

  afterAll(async () => {
    await closeAccount(creator, funder)
  })
})

describe('Second Bid', () => {
  let funder: algosdk.Account
  let creator: algosdk.Account
  let firstBidder: algosdk.Account
  let secondBidder: algosdk.Account
  let globalDelta: ReadableGlobalStateDelta
  let appID: number

  beforeAll(async () => {
    const accounts = await getAccounts()
    funder = accounts[0]

    // create a new account to avoid app creation limit
    creator = algosdk.generateAccount()
    await fundAccount(funder, creator, 10_000_000)

    const appTxn = await createAppTxn(creator)
    const createResult = await sendTxn(appTxn)

    appID = createResult['application-index']

    const auctionStartTxns = await startAuctionTxns(appID, creator, 100_000, 3_600)
    await sendTxn(auctionStartTxns)

    firstBidder = algosdk.generateAccount()
    await fundAccount(funder, firstBidder, 10_000_000)
    secondBidder = algosdk.generateAccount()
    await fundAccount(funder, secondBidder, 10_000_000)

    const firstBidTxns = await getBidTxns(appID, firstBidder, firstBidAmount)
    await sendTxn(firstBidTxns)

    const secondBidTxns = await getBidTxns(appID, secondBidder, secondBidAmount)
    await createDryRunFromTxns(secondBidTxns, 'second_bid')
    const secondBidResult = await sendTxn(secondBidTxns)

    globalDelta = getReadableGlobalState(secondBidResult['global-state-delta'])
  })

  it('Global state delta == two', () => {
    expect(Object.keys(globalDelta).length).toBe(2)
  })

  it('highestBid == bid amount', () => {
    expect(globalDelta.highestBid).toBe(secondBidAmount)
  })

  it('highestBidder == bidder address', () => {
    expect(globalDelta.highestBidder).toBe(secondBidder.addr)
  })

  it('First bidder gets bid back (minus txn fee x3)', async () => {
    const balance = (await algodClient.accountInformation(firstBidder.addr).do()).amount
    expect(balance).toBe(10_000_000 - 3_000)
  })

  it('App balance == second bet + min balance', async () => {
    const appAddr = algosdk.getApplicationAddress(appID)
    const balance = (await algodClient.accountInformation(appAddr).do()).amount
    expect(balance).toBe(secondBidAmount + 100_000)
  })

  afterAll(async () => {
    await closeAccount(creator, funder)
  })
})

async function getAuctionEndTxn (id: number, from: algosdk.Account) {
  const suggestedParams = await algodClient.getTransactionParams().do()

  const accounts = [] as Array<string>

  const gState = getReadableGlobalState((await algodClient.getApplicationByID(id).do()).params['global-state'])
  const highestBidder = gState.highestBidder

  if (highestBidder) {
    accounts.push(highestBidder as string)
  }

  const appObj = {
    suggestedParams: { ...suggestedParams },
    from: from.addr,
    appIndex: id,
    appArgs: [
      new Uint8Array(Buffer.from('end_auction'))
    ],
    accounts: accounts
  } as any

  return algosdk.makeApplicationCallTxnFromObject(appObj).signTxn(from.sk)
}

// TODO: Somehow test account balances. Currently this isn't possible since dryrun endpoint doesn't return account deltas.
describe('Auction End', () => {
  let funder: algosdk.Account
  let creator: algosdk.Account
  let firstBidder: algosdk.Account
  let secondBidder: algosdk.Account
  let globalDelta: ReadableGlobalStateDelta
  let appID: number

  beforeAll(async () => {
    const accounts = await getAccounts()
    funder = accounts[0]

    // create a new account to avoid app creation limit
    creator = algosdk.generateAccount()
    await fundAccount(funder, creator, 10_000_000)

    const appTxn = await createAppTxn(creator)
    const createResult = await sendTxn(appTxn)

    appID = createResult['application-index']

    const auctionStartTxns = await startAuctionTxns(appID, creator, 100_000, 3_600)
    await sendTxn(auctionStartTxns)

    firstBidder = algosdk.generateAccount()
    await fundAccount(funder, firstBidder, 10_000_000)
    secondBidder = algosdk.generateAccount()
    await fundAccount(funder, secondBidder, 10_000_000)

    const firstBidTxns = await getBidTxns(appID, firstBidder, firstBidAmount)
    await sendTxn(firstBidTxns)

    const secondBidTxns = await getBidTxns(appID, secondBidder, secondBidAmount)
    await sendTxn(secondBidTxns)

    const auctionEndTxn = await getAuctionEndTxn(appID, creator)
    const endDr = await createDryRunFromTxns([auctionEndTxn], 'auction_end', 1901574052)
    const endDrResult = await algodClient.dryrun(endDr).do()

    globalDelta = getReadableGlobalState(endDrResult.txns[0]['global-delta'])
  })

  it('Global state delta == two', () => {
    expect(Object.keys(globalDelta).length).toBe(3)
  })

  it('auctionEnd == 0', () => {
    expect(globalDelta.auctionEnd).toBe(0)
  })

  it('owner == highestBidder', () => {
    expect(globalDelta.owner).toBe(secondBidder.addr)
  })

  it('highestBidder == undefined', () => {
    expect(globalDelta.highestBidder).toBe(undefined)
  })

  afterAll(async () => {
    await closeAccount(creator, funder)
  })
})