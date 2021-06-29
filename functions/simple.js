const functions = require("firebase-functions");
// const admin = require("firebase-admin");
const ccxt = require('ccxt');
const { IncomingWebhook } = require('@slack/webhook');

exports.onTick = functions
  .region('asia-northeast1')
  .pubsub.schedule('* * * * *')
  .timeZone('Asia/Tokyo')
  .onRun(async _ => await onTickExport())

function floorDecimal(value, base) {
  return Math.floor(value * Math.pow(10, base)) / Math.pow(10, base); 
}

const leastAmount = 0.0001;
const leastAmountMap = {
  BTC: 0.001,
  ETH: 0.001,
  LTC: 0.001,
  BCC: 0.001,
  MONA: 1,
  XRP: 1,
  XLM: 1,
  QTUM: 1,
  BAT: 1,
  JPY: 1000,
}
const tradingFeeRate = 0.0012;
const thresholdBenefit = 1;
const currencyPairs = [
  'BTC/JPY',
  'XRP/JPY',
  'ETH/JPY',
  'LTC/JPY',
  'BCH/JPY',
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
let orderBooks = {}

/// == prepare exchanges 
const bitbank = new ccxt.bitbank();
// bitbank.setSandboxMode(true);
bitbank.apiKey = functions.config().bitbank ? functions.config().bitbank.apikey : process.env.apikey;
bitbank.secret = functions.config().bitbank ? functions.config().bitbank.secret : process.env.secret;

/// prepare slack webhook
const url = functions.config().slack ? functions.config().slack : process.env.slack;
const webhook = url ? new IncomingWebhook(url) : null;

if (process.env.apikey) {
  onTickExport();
}

async function getAllaskBid() {
  const limit = 1;
  const allorderbooks = await Promise.all(currencyPairs.map((symbol) => {
    return bitbank.fetchOrderBook(symbol, limit);
  }))
  allorderbooks.forEach(orderBook => {
    orderBooks[orderBook.symbol] = orderBook;
  });
}

// async function getAskBid(symbol) {
function getAskBid(symbol) {
  // const orderBook = orderBooks[symbol] ? orderBooks[symbol] 
  //   : await bitbank.fetchOrderBook(symbol, 1, {limit: 1});

  // orderBooks[symbol] = orderBook; // For performance

  // const orderBook = await bitbank.fetchOrderBook(symbol);

  const orderBook = orderBooks[symbol];

  // why inversed?
  const ask = orderBook.bids[0][0];
  const bid = orderBook.asks[0][0];
  const askAmount = orderBook.bids[0][1];
  const bidAmount = orderBook.asks[0][1];
  const length = orderBook.asks.length;
  return { orderBook, ask, bid, askAmount, bidAmount, length };
}

async function onTickExport() {
  functions.logger.info("invoked", {});
  await getAllaskBid();
  innerArbitrage();
  functions.logger.info("fin", {});
}

async function innerArbitrage() {
  // TODO: inversed arbitrage
  functions.logger.info("invoked: innerArbitrage", {});
    
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
      estimateAndOrder(symbol, midSymbol, targCurrency, rootCurrency)
    };
  };
  functions.logger.info("fin: innerArbitrage", {});
}

async function estimateAndOrder(symbol, midSymbol, targCurrency, rootCurrency) {
  const midTargCurrency = midSymbol.match(/(.+)\//)[1];
  const midRootCurrency = midSymbol.match(/\/(.+)/)[1];
  const isAsk = midTargCurrency === targCurrency
  const goalSymbol = isAsk ? midRootCurrency + '/' + rootCurrency 
                            : midTargCurrency + '/' + rootCurrency;

  // const askBids = await Promise.all([
  // functions.logger.info("innerArbitrage: Promise set", {});
  // Promise.all([
  //   getAskBid(symbol),
  //   getAskBid(midSymbol),
  //   getAskBid(goalSymbol)
  // ])//;
  // .then((askBids) => {
  // const rootAskBid = askBids[0];
  // const midAskBid = askBids[1];
  // const goalAskBid = askBids[2];

  const rootAskBid = getAskBid(symbol);
  const midAskBid = getAskBid(midSymbol);
  const goalAskBid = getAskBid(goalSymbol);

  // fee = price * amount * feerate
  const buyEstimation = (() => {
    const midCost = isAsk ? midAskBid.ask : midAskBid.bid;
    const midAmount = isAsk ? midAskBid.askAmount : midAskBid.bidAmount;
    const midFee = leastAmount * midCost * tradingFeeRate;
    const estimate = ((leastAmount - midFee) / midCost);
    if (estimate > midAmount) {
      const midFee = midAmount * midCost * tradingFeeRate;
      const rootBuy = midAmount * midCost + midFee;
      return {
        estimate,
        midBuy: midAmount,
        midFee,
        rootBuy,
        rootFee: rootBuy + midFee
      };
    }
    const rootFee = leastAmount * rootAskBid.bid * tradingFeeRate;
    return {
      estimate,
      midBuy: estimate,
      rootBuy: leastAmount,
      rootFee,
      midFee
    };
  })();
  const midBuy = buyEstimation.midBuy;
  const midFee = buyEstimation.midFee;
  const rootBuy = buyEstimation.rootBuy;
  const rootFee = buyEstimation.rootFee;

  console.log(buyEstimation);

  const goalCost = isAsk ? goalAskBid.bid : goalAskBid.ask; 
  const goalSell = goalCost * midBuy;
  const goalFee = goalSell * tradingFeeRate;
  const total = (goalSell - goalFee) - (rootBuy * rootAskBid.bid);
  const totalWithFee = total - rootFee;

  const output = {
    root: {
      symbol,
      amount: rootBuy,
      bid: rootAskBid.bid,
      fee: rootFee
    },
    mid: {
      symbol: midSymbol,
      amount: midBuy,
      bid: midAskBid.bid,
      ask: midAskBid.ask,
      fee: midFee,
    },
    goal: {
      symbol: goalSymbol,
      amount: midBuy,
      ask: goalAskBid.ask,
      sell: goalSell,
      fee: goalFee,
    },
    isAsk,
    estimate: buyEstimation.estimate,
    midBidAmount: midAskBid.bidAmount,
    midBidPrice: midAskBid.bid,
    total,
    totalWithFee,
  };
  console.log({
    goalSym: output.goal.symbol,
    result: output.totalWithFee,
  });
  if (output.totalWithFee >= thresholdBenefit) {
    tradeArbitrage(output);
  }
// });
}

async function webhookSend(chancePair) {
  const balance = await bitbank.fetchBalance()
  let attachments = [
    {
      color: 'good',
      fields: [
        {
          title: chancePair.root.symbol,
          value: 'amount: ' + chancePair.root.amount + '\n'
            + 'cost: ' + chancePair.root.bid * chancePair.root.amount + '\n' 
            + 'fee: ' + chancePair.root.fee
        }
      ]
    },
    {
      color: 'good',
      fields: [
        {
          title: chancePair.mid.symbol,
          value: 'amount: ' + chancePair.mid.amount + '\n'
            + 'cost: ' + chancePair.mid.bid * chancePair.mid.amount + '\n' 
            + 'fee: ' + chancePair.mid.fee
        }
        ]
    },
    {
      color: 'good',
      fields: [
        {
          title: chancePair.goal.symbol,
          value: 'amount: ' + chancePair.goal.amount + '\n'
            + 'cost: ' + chancePair.goal.ask * chancePair.goal.amount + '\n' 
            + 'fee: ' + chancePair.goal.fee
        }
      ]
    },
    {
      color: 'warning',
      fields: [
        {
          title: 'Total Balance',
          value: Object.keys(balance.total).map((key) => {
            return key + ': ' + balance.total[key]
          }).join(', ')
        }
      ]
    }
  ];

  return webhook.send({
    username: 'Harvest 2: Simple',
    icon_emoji: ':moneybag:',
    text: 'Result: ' + floorDecimal(chancePair.totalWithFee, 5) + ' yen'
      + '\n JPY: ' + balance.total.JPY + ' yen',
    attachments
  });
}

async function tradeArbitrage(chancePair) {
  functions.logger.info("invoked: -- trade", chancePair);
  bitbank.createLimitBuyOrder(chancePair.root.symbol, chancePair.root.amount, chancePair.root.bid)
  bitbank.createLimitBuyOrder(chancePair.mid.symbol, chancePair.mid.amount, chancePair.mid.bid)
  bitbank.createLimitSellOrder(chancePair.goal.symbol, chancePair.goal.amount, chancePair.goal.ask)
  console.log(chancePair);
  webhookSend(chancePair);
  functions.logger.info("fin: -- trade", {});
}


