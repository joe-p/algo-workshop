import algosdk from 'algosdk'
import * as fs from 'fs'

const server = 'http://localhost'
const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const algodClient = new algosdk.Algodv2(token, server, 4001)
const kmdClient = new algosdk.Kmd(token, server, 4002)
const kmdWallet = 'unencrypted-default-wallet'
const kmdPassword = ''

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

/*
    [
      { key: 'ZW5k', value: { action: 2, uint: 1234 } },
      {
        key: 'a2luZw==',
        value: {
          action: 1,
          bytes: '6EPYbfAJDEe8EpxNr7W3yCk4/sUE9kUS+BOhFq+cih8='
        }
      }
    ]

    Becomes...

    {
      end: 1234,
      king: '5BB5Q3PQBEGEPPASTRG27NNXZAUTR7WFAT3EKEXYCOQRNL44RIPWPWZSQQ'
    }
*/
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

async function createAppTxn (creator: algosdk.Account, endTime: number) {
  const approval = await compileProgram(fs.readFileSync('approval.teal').toString())
  const clear = await compileProgram(fs.readFileSync('clear.teal').toString())

  const appObj = {
    suggestedParams: await algodClient.getTransactionParams().do(),
    from: creator.addr,
    numGlobalByteSlices: 1,
    numGlobalInts: 1,
    approvalProgram: approval,
    clearProgram: clear,
    extraPages: 1,
    appArgs: [ algosdk.encodeUint64(endTime) ]
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

  beforeAll(async () => {
    const accounts = await getAccounts()
    funder = accounts[0]

    // create a new account to avoid app creation limit
    creator = algosdk.generateAccount()
    await fundAccount(funder, creator, 10_000_000)

    const appTxn = await createAppTxn(creator, 1234)
    const appDr = await createDryRunFromTxns([appTxn], 'app_create')
    const appDrRes = await algodClient.dryrun(appDr).do()
    rawGlobalState = appDrRes.txns[0]['global-delta']

    globalState = getReadableGlobalState(appDrRes.txns[0]['global-delta'])
  })

  it('Global[end] == specified end time', () => {
    expect(globalState.end).toBe(1234)
  })

  it('Global[king] == creator address', () => {
    expect(globalState.king).toBe(creator.addr)
  })

  afterAll(async () => {
    await closeAccount(creator, funder)
  })
})


async function getNewKingTxn (id: number, from: algosdk.Account) {
  const suggestedParams = await algodClient.getTransactionParams().do()

  const appObj = {
    suggestedParams: { ...suggestedParams },
    from: from.addr,
    appIndex: id,
  } as any

  return algosdk.makeApplicationCallTxnFromObject(appObj).signTxn(from.sk)
}

// TODO: Somehow test account balances. Currently this isn't possible since dryrun endpoint doesn't return account deltas.
describe('New King', () => {
  let funder: algosdk.Account
  let creator: algosdk.Account
  let newKing: algosdk.Account
  let globalDelta: ReadableGlobalStateDelta
  let appID: number

  beforeAll(async () => {
    const accounts = await getAccounts()
    funder = accounts[0]

    creator = algosdk.generateAccount()
    newKing = algosdk.generateAccount()

    await fundAccount(funder, creator, 10_000_000)
    await fundAccount(funder, newKing, 10_000_000)

    const appTxn = await createAppTxn(creator, 1234)
    const createResult = await sendTxn(appTxn)

    appID = createResult['application-index']

    const newKingTxn = await getNewKingTxn(appID, newKing)
    const newKingDr = await createDryRunFromTxns([newKingTxn], 'new_king', 123)
    const newKingDrResult = await algodClient.dryrun(newKingDr).do()

    console.log(newKingDrResult.txns[0])
    globalDelta = getReadableGlobalState(newKingDrResult.txns[0]['global-delta'])
  })

  it('Global state delta == one', () => {
    expect(Object.keys(globalDelta).length).toBe(1)
  })

  it('Global[king] == newKing address', () => {
    expect(globalDelta.king).toBe(newKing.addr)
  })

  afterAll(async () => {
    await closeAccount(creator, funder)
  })
})
/*
async function getStartSaleTxn (id: number, from: algosdk.Account, price: number) {
  const suggestedParams = await algodClient.getTransactionParams().do()

  const accounts = [] as Array<string>

  const appObj = {
    suggestedParams: { ...suggestedParams },
    from: from.addr,
    appIndex: id,
    appArgs: [
      new Uint8Array(Buffer.from('start_sale')),
      algosdk.encodeUint64(price)
    ],
    accounts: accounts
  } as any

  return algosdk.makeApplicationCallTxnFromObject(appObj).signTxn(from.sk)
}

describe('Sale Start', () => {
  let funder: algosdk.Account
  let creator: algosdk.Account
  let royaltyAccount: algosdk.Account
  let globalDelta: ReadableGlobalStateDelta
  let appID: number

  beforeAll(async () => {
    const accounts = await getAccounts()
    funder = accounts[0]

    // create a new account to avoid app creation limit
    creator = algosdk.generateAccount()
    await fundAccount(funder, creator, 10_000_000)

    royaltyAccount = algosdk.generateAccount()

    const appTxn = await createAppTxn(creator, royaltyAccount, 9, 'Hello World!', 7)
    const createResult = await sendTxn(appTxn)

    appID = createResult['application-index']

    const startSaleTxn = await getStartSaleTxn(appID, creator, 100)
    await createDryRunFromTxns([startSaleTxn], 'start_sale')
    const startResult = await sendTxn(startSaleTxn)

    globalDelta = getReadableGlobalState(startResult['global-state-delta'])
  })

  it('Global state delta == one', () => {
    expect(Object.keys(globalDelta).length).toBe(1)
  })

  it('Sale Price == given sale price', () => {
    expect(globalDelta['Sale Price']).toBe(100)
  })

  afterAll(async () => {
    await closeAccount(creator, funder)
  })
})

async function getBuyTxns (id: number, from: algosdk.Account, price: number) {
  const appResult = await algodClient.getApplicationByID(id).do()

  const gState = (getReadableGlobalState(appResult.params['global-state']))
  const royaltyPercentState = gState['Royalty Percent'] as number
  const payPercent = (100 - royaltyPercentState) / 100
  const royaltyPercent = (royaltyPercentState) / 100

  const suggestedParams = await algodClient.getTransactionParams().do()

  const appObj = {
    suggestedParams: { ...suggestedParams },
    from: from.addr,
    appIndex: id,
    appArgs: [
      new Uint8Array(Buffer.from('buy'))
    ]
  } as any

  const payObj = {
    suggestedParams: { ...suggestedParams },
    from: from.addr,
    to: gState.Owner,
    amount: Math.round(price * payPercent)
  } as any

  const royaltyObj = {
    suggestedParams: { ...suggestedParams },
    from: from.addr,
    to: gState['Royalty Address'],
    amount: Math.round(price * royaltyPercent)
  } as any

  const txns = [] as Array<algosdk.Transaction>
  txns.push(algosdk.makeApplicationCallTxnFromObject(appObj))
  txns.push(algosdk.makePaymentTxnWithSuggestedParamsFromObject(payObj))
  txns.push(algosdk.makePaymentTxnWithSuggestedParamsFromObject(royaltyObj))

  const gTxn = algosdk.assignGroupID(txns)

  return gTxn.map(t => t.signTxn(from.sk))
}

describe('Buy', () => {
  let funder: algosdk.Account
  let creator: algosdk.Account
  let royaltyAccount: algosdk.Account
  let buyer: algosdk.Account
  let globalDelta: ReadableGlobalStateDelta
  let appID: number
  let creatorPreSaleBalance: number
  let royaltyPreSaleBalance: number

  beforeAll(async () => {
    const accounts = await getAccounts()
    funder = accounts[0]

    // create a new account to avoid app creation limit
    creator = algosdk.generateAccount()
    await fundAccount(funder, creator, 10_000_000)

    royaltyAccount = algosdk.generateAccount()

    const appTxn = await createAppTxn(creator, royaltyAccount, 9, 'Hello World!', 7)
    const createResult = await sendTxn(appTxn)

    appID = createResult['application-index']

    const startSaleTxn = await getStartSaleTxn(appID, creator, 100)
    await sendTxn(startSaleTxn)

    buyer = algosdk.generateAccount()
    await fundAccount(funder, buyer, 10_000_000)
    await fundAccount(funder, royaltyAccount, 10_000_000)

    const buyTxns = await getBuyTxns(appID, buyer, 100)
    await createDryRunFromTxns(buyTxns, 'buy')

    creatorPreSaleBalance = (await algodClient.accountInformation(creator.addr).do()).amount
    royaltyPreSaleBalance = (await algodClient.accountInformation(royaltyAccount.addr).do()).amount

    const buyResult = await sendTxn(buyTxns)

    globalDelta = getReadableGlobalState(buyResult['global-state-delta'])
  })

  it('Global state delta == two', () => {
    expect(Object.keys(globalDelta).length).toBe(2)
  })

  it('Sale Price == undefined', () => {
    expect(globalDelta['Sale Price']).toBe(undefined)
  })

  it('Owner == buyer address', () => {
    expect(globalDelta.Owner).toBe(buyer.addr)
  })

  it('Owner balance += sale_price*(100-royalty percent)', async () => {
    const balance = (await algodClient.accountInformation(creator.addr).do()).amount
    expect(balance).toBe(91 + creatorPreSaleBalance)
  })

  it('Royalty balance += sale_price*royalty percent', async () => {
    const balance = (await algodClient.accountInformation(royaltyAccount.addr).do()).amount
    expect(balance).toBe(9 + royaltyPreSaleBalance)
  })

  afterAll(async () => {
    await closeAccount(creator, funder)
    await closeAccount(buyer, funder)
    await closeAccount(royaltyAccount, funder)
  })
})

async function getTransferTxn (id: number, from: algosdk.Account, to: algosdk.Account) {
  const suggestedParams = await algodClient.getTransactionParams().do()

  const accounts = [] as Array<string>

  accounts.push(to.addr)

  const appObj = {
    suggestedParams: { ...suggestedParams },
    from: from.addr,
    appIndex: id,
    appArgs: [
      new Uint8Array(Buffer.from('transfer')),
      algosdk.decodeAddress(to.addr).publicKey
    ],
    accounts: accounts
  } as any

  return algosdk.makeApplicationCallTxnFromObject(appObj).signTxn(from.sk)
}

describe('Transfer', () => {
  let funder: algosdk.Account
  let creator: algosdk.Account
  let royaltyAccount: algosdk.Account
  let receiver: algosdk.Account
  let globalDelta: ReadableGlobalStateDelta
  let appID: number

  beforeAll(async () => {
    const accounts = await getAccounts()
    funder = accounts[0]

    // create a new account to avoid app creation limit
    creator = algosdk.generateAccount()
    await fundAccount(funder, creator, 10_000_000)

    royaltyAccount = algosdk.generateAccount()

    const appTxn = await createAppTxn(creator, royaltyAccount, 9, 'Hello World!', 7)
    const createResult = await sendTxn(appTxn)

    appID = createResult['application-index']

    receiver = algosdk.generateAccount()
    await fundAccount(funder, receiver, 10_000_000)

    const transferTxn = await getTransferTxn(appID, creator, receiver)
    const transferDr = await createDryRunFromTxns([transferTxn], 'transfer')
    const transferDrResult = await algodClient.dryrun(transferDr).do()

    globalDelta = getReadableGlobalState(transferDrResult.txns[0]['global-delta'])
  })

  it('Global state delta == one', () => {
    expect(Object.keys(globalDelta).length).toBe(1)
  })

  it('Owner == receiver', () => {
    expect(globalDelta.Owner).toBe(receiver.addr)
  })

  afterAll(async () => {
    await closeAccount(creator, funder)
    await closeAccount(receiver, funder)
  })
})
*/