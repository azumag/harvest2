const functions = require("firebase-functions");
// const admin = require("firebase-admin");
const ccxt = require('ccxt');
const { IncomingWebhook } = require('@slack/webhook');

exports.onTick = functions
  .region('asia-northeast1')
  .pubsub.schedule('* * * * *')
  .timeZone('Asia/Tokyo')
  .onRun(async _ => await onTickExport())

function floorDecimal(value, n) {
  return Math.floor(value * Math.pow(10, n) ) / Math.pow(10, n);
}

const leastAmount = 0.001;
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

async function getOrderBook(symbol) {
  const orderBook = orderBooks[symbol] ? orderBooks[symbol] 
    : await bitbank.fetchOrderBook(symbol, 1, {limit: 1});

  // orderBooks[symbol] = orderBook; // For performance

  // why ask/bid inversed?
  const ask = orderBook.bids[0][0];
  const bid = orderBook.asks[0][0];

  const askAmount = orderBook.bids[0][1];
  const bidAmount = orderBook.asks[0][1];
  const length = orderBook.asks.length;
  return { ask, bid, askAmount, bidAmount, length };
}

async function onTickExport() {
  functions.logger.info("invoked", {});
  await innerArbitrage();
  functions.logger.info("fin", {});
}

function findNextPairs(rootCurrency, targCurrency, srcCurrency, isFirst) {
  if (!isFirst & [rootCurrency, targCurrency].includes(srcCurrency)) {
    return {rootCurrency, targCurrency}
  }

  const nextPairSymbols = currencyPairs.filter((targSym) => {
    return targSym !== targCurrency + '/' + rootCurrency && targSym.includes(targCurrency);
  });
  return {
    rootCurrency, targCurrency, next: nextPairSymbols.map((nextPairSymbol) => {
      const rootCurrency = nextPairSymbol.match(/\/(.+)/)[1];
      const ntargCurrency = nextPairSymbol.match(/(.+)\//)[1];

      if (ntargCurrency === targCurrency) {
        return findNextPairs(ntargCurrency, rootCurrency, srcCurrency, false)
      } else {
        return findNextPairs(rootCurrency, ntargCurrency, srcCurrency, false)
      }
    })
  }
}

function symbolize(currencyA, currencyB) {
  return currencyA + '/' + currencyB;
}

function getSymbolWithDirection(rootCurrency, targCurrency) {
 const buyDirection = symbolize(targCurrency, rootCurrency);
 const sellDirection = symbolize(rootCurrency, targCurrency);

 if (currencyPairs.includes(buyDirection)) {
    return {symbol: buyDirection, direction: 'buy'}
 } else if (currencyPairs.includes(sellDirection)) {
    return {symbol: sellDirection, direction: 'sell'}
 } else {
   throw new Error('Unexpected direction sybol'); 
 }
}

async function getAllRouteAskBid(routes) {
  const symbolWithDirection = getSymbolWithDirection(routes.rootCurrency, routes.targCurrency);
  const rootOrderBook = getOrderBook(symbolWithDirection.symbol)
}

async function innerArbitrage() {
  functions.logger.info("invoked: innerArbitrage", {});
    
  for(let i=0; i < currencyPairs.length; i++) {
    const symbol = currencyPairs[i];
    const rootCurrency = symbol.match(/\/(.+)/)[1];
    const targCurrency = symbol.match(/(.+)\//)[1];
    const routes = findNextPairs(rootCurrency, targCurrency, rootCurrency, true);

    console.log(routes);
    console.log(await getAllRouteAskBid(routes))
    console.log(getSymbolWithDirection('BAT', 'JPY'))

    break;

    
  //     const askBids = await Promise.all([
  //       getAskBid(symbol),
  //       getAskBid(midSymbol),
  //       getAskBid(goalSymbol)
  //     ]);
  //     const rootAskBid = askBids[0];
  //     const midAskBid = askBids[1];
  //     const goalAskBid = askBids[2];

  //     // fee = price * amount * feerate
  //     const buyEstimation = (() => {
  //       const midCost = isAsk ? midAskBid.ask : midAskBid.bid;
  //       const midAmount = isAsk ? midAskBid.askAmount : midAskBid.bidAmount;
  //       const midFee = leastAmount * midCost * tradingFeeRate;
  //       const estimate = ((leastAmount - midFee) / midCost);
  //       if (estimate > midAmount) {
  //         const midFee = midAmount * midCost * tradingFeeRate;
  //         const rootBuy = midAmount * midCost + midFee;
  //         return {
  //           estimate,
  //           midBuy: midAmount,
  //           midFee,
  //           rootBuy,
  //           rootFee: rootBuy + midFee
  //         };
  //       }
  //       const rootFee = leastAmount * rootAskBid.bid * tradingFeeRate;
  //       return {
  //         estimate,
  //         midBuy: estimate,
  //         rootBuy: leastAmount,
  //         rootFee,
  //         midFee
  //       };
  //     })();
  //     const midBuy = buyEstimation.midBuy;
  //     const midFee = buyEstimation.midFee;
  //     const rootBuy = buyEstimation.rootBuy;
  //     const rootFee = buyEstimation.rootFee;

  //     console.log(buyEstimation);

  //     const goalCost = isAsk ? goalAskBid.bid : goalAskBid.ask; 
  //     const goalSell = goalCost * midBuy;
  //     const goalFee = goalSell * tradingFeeRate;
  //     const total = (goalSell - goalFee) - (rootBuy * rootAskBid.bid);
  //     const totalWithFee = total - rootFee;

  //     const output = {
  //       root: {
  //         symbol,
  //         amount: rootBuy,
  //         bid: rootAskBid.bid,
  //         fee: rootFee
  //       },
  //       mid: {
  //         symbol: midSymbol,
  //         amount: midBuy,
  //         bid: midAskBid.bid,
  //         ask: midAskBid.ask,
  //         fee: midFee,
  //       },
  //       goal: {
  //         symbol: goalSymbol,
  //         amount: midBuy,
  //         ask: goalAskBid.ask,
  //         sell: goalSell,
  //         fee: goalFee,
  //       },
  //       isAsk,
  //       estimate: buyEstimation.estimate,
  //       midBidAmount: midAskBid.bidAmount,
  //       midBidPrice: midAskBid.bid,
  //       total,
  //       totalWithFee,
  //     };
  //     console.log({
  //       isAsk,
  //       goalSym: output.goal.symbol,
  //       result: output.totalWithFee,
  //     });
  //     if (output.totalWithFee >= thresholdBenefit) {
  //       // tradeArbitrage(output);
  //     }
  //     // webhookSend(output);
  //   };
  };
  functions.logger.info("fin: innerArbitrage", {});
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
    username: 'Harvest 2',
    icon_emoji: ':moneybag:',
    text: 'Result: ' + chancePair.totalWithFee + ' yen'
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


