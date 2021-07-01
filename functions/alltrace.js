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
  const pow = Math.pow(10, n);
  return Math.floor(value * pow) / pow;
}

const leastAmount = 0.0001;
const tradingFee = 0.0012;
const tradingFeeRate = tradingFee + 1;
const units = {
  JPY: 1000
};
// const unit = {
//   BTC: 0.0001,
//   ETH: 0.001,
//   LTC: 0.002,
//   BCH: 0.01,
//   MONA: 5,
//   XRP: 10,
//   XLM: 10,
//   QTUM: 1,
//   BAT: 10,
//   JPY: 1000,
// }
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
  'OMG/JPY',
  'OMG/BTC'
];
let allOrderBooks = {}

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

async function onTickExport() {
  functions.logger.info("invoked", {});
  await Promise.all([
    setUnits(),
    getAllOrderBooks()
  ])
  await innerArbitrage();
  functions.logger.info("fin", {});
}

async function setUnits() {
  functions.logger.info("setUnits", {});
  const tickers = await getTickerLasts();
  // console.log(tickers)
  const maxTicker = tickers.reduce((a,b) => a.last > b.last ? a : b)
  const basicRate = leastAmount * maxTicker.last;
  const maxCurrency = maxTicker.symbol.match(/(.+)\//)[1];

  tickers.forEach((ticker) => {
    const targCurrency = ticker.symbol.match(/(.+)\//)[1];
    if (units[targCurrency]) {
      return;
    }
    if (targCurrency === maxCurrency) {
      units[targCurrency] = leastAmount;
    } else {
      units[targCurrency] = basicRate / ticker.last;
    }
  });
  console.log(units);
}

async function getTickerLasts() {
  return Promise.all(currencyPairs.map((symbol) => {
    return bitbank.fetchTicker(symbol);
  }));
}

async function getAllOrderBooks() {
  functions.logger.info("invoked: getAllOrderBooks", {});
  const limit = 1;
  const _allorderbooks = await Promise.all(currencyPairs.map((symbol) => {
    return bitbank.fetchOrderBook(symbol, limit);
  }))
  _allorderbooks.forEach(orderBook => {
    allOrderBooks[orderBook.symbol] = orderBook;
  });
  functions.logger.info("fin: getAllOrderBooks", {});
}

// async function getOrderBook(symbol) {
function getOrderBook(symbol) {
  // const orderBook = allOrderBooks[symbol] ? allOrderBooks[symbol] 
  //   : await bitbank.fetchOrderBook(symbol, 1, {limit: 1});

  // allOrderBooks[symbol] = orderBook; // For performance

  const orderBook = allOrderBooks[symbol];

  // CHECK: why ask/bid inversed?
  return { 
    price: {
      ask: orderBook.bids[0][0],
      bid: orderBook.asks[0][0],
    },
    amount: {
      ask: orderBook.bids[0][1],
      bid: orderBook.asks[0][1]
    } 
  };
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
    return {
      symbol: buyDirection, direction: 'buy',
      rootCurrency, targCurrency
    }
 } else if (currencyPairs.includes(sellDirection)) {
    return {
      symbol: sellDirection, direction: 'sell',
      rootCurrency: targCurrency,
      targCurrency: rootCurrency
    }
 } else {
   console.log({buyDirection, sellDirection});
   throw new Error('Unexpected direction sybol'); 
 }
}


async function estimateAndOrder(routes, orderBooks) {
  const symbolWithDirection = getSymbolWithDirection(routes.rootCurrency, routes.targCurrency);
  // const orderBook = await getOrderBook(symbolWithDirection.symbol);
  const orderBook = getOrderBook(symbolWithDirection.symbol);

  orderBooks.push({
    ...symbolWithDirection,
    ...orderBook
  });

  if (routes.next !== undefined) {
    for(let i=0; i<routes.next.length; i++) {
      const _next = routes.next[i];
      // await estimateAndOrder(_next, Array.from(orderBooks));
      estimateAndOrder(_next, Array.from(orderBooks));
    }
  } else {
    // last node
    // console.log(orderChain);
    orderBooks.reverse();
    for(let i=0; i<orderBooks.length; i++) {
      const orderBook = orderBooks[i];
      const nextOrder = orderBooks[i-1];

      switch (orderBook.direction) {
        case 'sell':
          if (!nextOrder) { // means last order
            orderBook.estimatedAmount = Math.min(orderBook.amount.ask, units[orderBook.targCurrency]);
            const price = orderBook.price.ask * orderBook.estimatedAmount;
            orderBook.estimatedCost  = price;
            orderBook.estimatedResult = price - (price * tradingFee)
          } else {
            switch (nextOrder.direction) {
              case 'buy':
                orderBook.estimatedAmount = (nextOrder.estimatedCostWithFee * tradingFeeRate) / orderBook.price.ask;
                orderBook.estimatedCostWithFee = (nextOrder.estimatedCostWithFee * tradingFeeRate);
                break;
              case 'sell':
                const estimatedCostWithFee = nextOrder.estimatedAmount * tradingFeeRate;
                orderBook.estimatedAmount = estimatedCostWithFee / orderBook.price.ask;
                orderBook.estimatedCostWithFee = estimatedCostWithFee;
                break;
              default:
                break;
            }
          }
          orderBook.estimatedPrice = orderBook.price.ask;
          break;
        case 'buy':
          if (!nextOrder) {
            orderBook.estimatedAmount = Math.min(orderBook.amount.bid, units[orderBook.targCurrency]);
            orderBook.estimatedResult = orderBook.estimatedAmount;
          } else {
            switch (nextOrder.direction) {
              case 'buy':
                orderBook.estimatedAmount = nextOrder.estimatedCostWithFee;
                break;
              case 'sell':
                orderBook.estimatedAmount = nextOrder.estimatedAmount;
                break;
              default:
                break;
            }
          }
          orderBook.estimatedPrice  = orderBook.price.bid;
          orderBook.estimatedCost   = orderBook.estimatedPrice * orderBook.estimatedAmount;
          orderBook.estimatedCostWithFee = orderBook.estimatedCost * tradingFeeRate;
          break;
        default:
          break;
      }
    }
    // estimate
    orderBooks.reverse();
    const firstOrder = orderBooks[0];
    const lastOrder  = orderBooks.slice(-1)[0];
    const benefit    = lastOrder.estimatedResult - firstOrder.estimatedCostWithFee;

    console.log({orderBooks, benefit});
    let threshold = thresholdBenefit;
    if (firstOrder.rootCurrency !== 'JPY') {
      threshold = 0.000001;
    }
    if (benefit > threshold) {
      // and order
      webhookSend(orderBooks, benefit);
      orderBooks.forEach(order => {
        trade(order)
      })
    }
  }
}

async function innerArbitrage() {
  functions.logger.info("invoked: innerArbitrage", {});
  // const balance = await bitbank.fetchBalance()
  // console.log(balance);

  for(let i=0; i < currencyPairs.length; i++) {
    const symbol = currencyPairs[i];
    const rootCurrency = symbol.match(/\/(.+)/)[1];
    const targCurrency = symbol.match(/(.+)\//)[1];
    const routes = findNextPairs(rootCurrency, targCurrency, rootCurrency, true);

    // if (symbol === 'BTC/JPY') {
    // if (symbol === 'XRP/JPY') {
    // if (symbol === 'XRP/BTC') {
      console.log(routes);
      estimateAndOrder(routes, []);
    // }
  };
  functions.logger.info("fin: innerArbitrage", {});
}

async function webhookSend(orders, benefit) {
  const balance = await bitbank.fetchBalance();
  let attachments = orders.map(order => {
    return {
      color: 'good',
      fields: [
        {
          title: order.symbol,
          value: 'amount: ' + order.estimatedAmount + '\n'
            + 'cost: ' + order.estimatedCost+ '\n' 
            + 'price: ' + order.estimatedPrice + '\n' 
            + 'trade: ' + order.direction + '\n' 
            + (order.estimatedResult === undefined) ? '' : ('result: ' + order.estimatedResult)
        }
      ]
    }
  });
  attachments.push({
    color: 'warning',
    fields: [
      {
        title: 'Total Balance',
        value: Object.keys(balance.total).map((key) => {
          return key + ': ' + balance.total[key]
        }).join(', ')
      }
    ]
  });

  return webhook.send({
    username: 'Harvest 2: All trace',
    icon_emoji: ':moneybag:',
    text: 'Result: ' + floorDecimal(benefit, 6) + ' unit'
      + '\n JPY: ' + balance.total.JPY + ' yen',
    attachments
  });
}

async function trade(order) {
  functions.logger.info("invoked: -- trade", order);
  switch (order.direction) {
    case 'sell':
      bitbank.createLimitSellOrder(order.symbol, order.estimatedAmount, order.estimatedPrice);
      break;
    case 'buy':
      bitbank.createLimitBuyOrder(order.symbol, order.estimatedAmount, order.estimatedPrice);
      break;
    default:
      break;
  }
  console.log(order);
  functions.logger.info("fin: -- trade", {});
}


