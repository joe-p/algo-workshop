#!/usr/bin/env python3
from pyteal import *
import os

ARGS = Txn.application_args

# Global Bytes (2)
OWNER = Bytes("owner")
HIGHEST_BIDDER = Bytes("highestBidder")

# Global Ints (2)
AUCTION_END = Bytes("auctionEnd")
HIGHEST_BID = Bytes("highestBid")

def get_type(input):
    if (type(input) == str):
        return Bytes(input)
    elif(type(input) == int):
        return Int(input)
    else:
        return input
    
def set(key, value):
    key = get_type(key)
    value = get_type(value)

    return App.globalPut(key, value)

def get(key):
    return App.globalGet(get_type(key))

def init():
    return Seq(
        # Set global bytes
        set(OWNER, Txn.sender()),
        set(HIGHEST_BIDDER, ""),
        
        # Set global ints
        set(AUCTION_END, Int(0)),
        set(HIGHEST_BID, Int(0)),

        Approve()
    )

def start_auction():
    payment = Gtxn[1]

    starting_price = Btoi(ARGS[1])
    length = Btoi(ARGS[2])

    return Seq(
        Assert(payment.receiver() == Global.current_application_address()),
        Assert(payment.amount() == Int(100_000)),
        set(AUCTION_END, Global.latest_timestamp() + length),
        set(HIGHEST_BID, starting_price),
        Approve()
    )

def pay(receiver, amount):
    return Seq(
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.Payment,
            TxnField.receiver: receiver,
            TxnField.amount: amount - Global.min_txn_fee()
        }),
        InnerTxnBuilder.Submit(),
    )

def end_auction():
    highest_bid = get(HIGHEST_BID)
    owner = get(OWNER)

    return Seq(
        Assert( Global.latest_timestamp() > get(AUCTION_END) ),
        pay(owner, highest_bid),
        set(AUCTION_END, Int(0)),
        set(OWNER, get(HIGHEST_BIDDER)),
        set(HIGHEST_BIDDER, Bytes("")),
        Approve()
    )

def bid():
    payment = Gtxn[1]
    app_call = Gtxn[0]
    highest_bidder = get(HIGHEST_BIDDER)
    highest_bid = get(HIGHEST_BID)

    return Seq(
        Assert(Global.latest_timestamp() < get(AUCTION_END) ),
        Assert(payment.amount() > highest_bid),
        Assert(app_call.sender() == payment.sender()),
        If( highest_bidder != Bytes(""), pay(highest_bidder, highest_bid) ),
        set(HIGHEST_BID, payment.amount()),
        set(HIGHEST_BIDDER, payment.sender()),
        Approve()
    )

def approval():
    fcn = ARGS[0]

    return Cond(
        [Txn.application_id() == Int(0), init()],
        [Txn.on_completion() == OnComplete.DeleteApplication, Reject()],
        [fcn == Bytes("start_auction"), start_auction()],
        [fcn == Bytes("bid"), bid()],
        [fcn == Bytes("end_auction"), end_auction()],
    )

def clear():
    return Approve()

if __name__ == "__main__":
    if os.path.exists("approval.teal"):
        os.remove("approval.teal") 
    
    if os.path.exists("approval.teal"):
        os.remove("clear.teal") 

    compiled_approval = compileTeal(approval(), mode=Mode.Application, version=5)

    with open("approval.teal", "w") as f:
        f.write(compiled_approval)

    compiled_clear = compileTeal(clear(), mode=Mode.Application, version=5)

    with open("clear.teal", "w") as f:
        f.write(compiled_clear)
