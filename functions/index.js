const functions = require("firebase-functions");
// const admin = require("firebase-admin");
const ccxt = require('ccxt')

exports.onTick = functions
  .region('asia-northeast1')
  .pubsub.schedule('* * * * *')
  .timeZone('Asia/Tokyo')
  .onRun(async _ => await onTickExport())

function floorDecimal(value, n) {
  return Math.floor(value * Math.pow(10, n) ) / Math.pow(10, n);
}

const leastAmount = 0.0001;
const tradingFeeRate = 0.0012;
const thresholdBenefit = 0;
const currencyPairs = [
  'BTC/JPY',
  'XRP/JPY',
  'ETH/JPY',
  'LTC/JPY',
  'BCC/JPY',
  'MONA/JPY',
  'XLM/JPY',
  'QTUM/JPY',
  'BAT/JPY',
  'XRP/BTC',
  'ETH/BTC',
  'LTC/BTC',
  'BCH/BTC',
  'MONA/BTC',
  'XLM/BTC',
  'QTUM/BTC',
  'BAT/BTC',
];

const bitbank = new ccxt.bitbank();
// bitbank.setSandboxMode(true);
bitbank.apiKey = functions.config().bitbank.apikey;
bitbank.secret = functions.config().bitbank.secret;

let orderBooks = {}
async function getAskBid(symbol) {
  const orderBook = orderBooks[symbol] ? orderBooks[symbol] : await bitbank.fetchOrderBook(symbol);
  orderBooks[symbol] = orderBook;
  ask = orderBook.asks[0][0];
  bid = orderBook.bids[0][0];
  return { orderBook, ask, bid };
}

async function onTickExport() {
  functions.logger.info("invoked", {});
  await innerArbitrage()
  functions.logger.info("fin", {});
}

async function innerArbitrage() {
  functions.logger.info("invoked: innerArbitrage", {});
  
  const chancePairs = [];
    
  for(let i=0; i < currencyPairs.length; i++) {
    const symbol = currencyPairs[i];
    const rootCurrency = symbol.match(/\/(.+)/)[1];
    const targCurrency = symbol.match(/(.+)\//)[1];

    const midPairs = currencyPairs.filter((targSym) => {
      return targSym != symbol && targSym.includes('/'+targCurrency);
    });

    if (midPairs.length > 0) {
      console.log({rootCurrency, targCurrency, midPairs})
    }

    for(let j=0; j < midPairs.length; j++) {
      const midSymbol = midPairs[j];
      const midTargCurrency = midSymbol.match(/(.+)\//)[1];
      const goalSymbol = midTargCurrency + '/' + rootCurrency;

      const askBids = await Promise.all([
        getAskBid(symbol),
        getAskBid(midSymbol),
        getAskBid(goalSymbol)
      ]);
      const rootAskBid = askBids[0];
      const midAskBid = askBids[1];
      const goalAskBid = askBids[2];

      // fee = price * amount * feerate
      const rootBuy = rootAskBid.bid * leastAmount;
      const rootFee = rootBuy * tradingFeeRate;
      const midFee = leastAmount * midAskBid.bid * tradingFeeRate;
      const midBuy = ((leastAmount - midFee) / midAskBid.bid);
      const goalSell = goalAskBid.ask * midBuy;
      const goalFee = goalSell * tradingFeeRate;
      const total = (goalSell - goalFee) - rootBuy;
      const totalWithFee = total - rootFee;

      const output = {
        root: {
          symbol,
          amount: leastAmount,
          bid: rootAskBid.bid,
          buy: rootBuy,
          fee: rootFee
        },
        mid: {
          symbol: midSymbol,
          amount: midBuy,
          bid: midAskBid.bid,
          buy: leastAmount,
          fee: midFee,
        },
        goal: {
          symbol: goalSymbol,
          amount: midBuy,
          ask: goalAskBid.ask,
          sell: goalSell,
          fee: goalFee,
        },
        total,
        totalWithFee,
      };
      if (output.totalWithFee >= thresholdBenefit) 
        chancePairs.push(output);
    };
  };
  console.log(chancePairs);
  // for(let i=0; i<chancePairs.length; i++) {
  //   await trade(chancePairs[i])
  // }
  try {
    await Promise.all(chancePairs.map(e => trade(e)));
  } catch (e) {
    functions.logger.info("error: innerArbitrage: call trade", {error: e});
  }
  functions.logger.info("fin: innerArbitrage", {});
}

async function trade(chancePair) {
  functions.logger.info("invoked: -- trade", chancePair);
  bitbank.createLimitBuyOrder(chancePair.root.symbol, chancePair.root.amount, chancePair.root.bid)
  bitbank.createLimitBuyOrder(chancePair.mid.symbol, chancePair.mid.amount, chancePair.mid.bid)
  bitbank.createLimitSellOrder(chancePair.goal.symbol, chancePair.goal.amount, chancePair.goal.ask)
  console.log(chancePair);
  functions.logger.info("fin: -- trade", {});
}

onTickExport();


