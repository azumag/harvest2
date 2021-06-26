const functions = require("firebase-functions");
// const admin = require("firebase-admin");
const ccxt = require('ccxt');
const { IncomingWebhook } = require('@slack/webhook');
const { extractInstanceAndPath } = require("firebase-functions/lib/providers/database");

exports.onTick = functions
  .region('asia-northeast1')
  .pubsub.schedule('* * * * *')
  .timeZone('Asia/Tokyo')
  .onRun(async _ => await onTickExport())

function floorDecimal(value, base) {
  return Math.floor(value * base) / base;
}

const leastAmount = 0.0001;
// TODO: saitei suuryou dynamically
// (0.0001 * 3774001)/70 = 5 = saitei suuryou
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
const tradingFeeRate = 1.0012;
const thresholdBenefit = 0;
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

async function onTickExport() {
  functions.logger.info("invoked", {});
  await setUnits();
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

async function getOrderBook(symbol) {
  const orderBook = orderBooks[symbol] ? orderBooks[symbol] 
    : await bitbank.fetchOrderBook(symbol, 1, {limit: 1});

  // orderBooks[symbol] = orderBook; // For performance

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


async function estimateAndOrder(routes, orderChain) {
  const symbolWithDirection = getSymbolWithDirection(routes.rootCurrency, routes.targCurrency);
  const orderBook = await getOrderBook(symbolWithDirection.symbol)

  orderChain.push({symbolWithDirection, orderBook})

  if (routes.next !== undefined) {
    for(let i=0; i<routes.next.length; i++) {
      const _next = routes.next[i];
      await estimateAndOrder(_next, Array.from(orderChain));
    }
  } else {
    // last node
    // console.log(orderChain);
    const planToOrder = [];
    for(let i=0; i<orderChain.length; i++) {
      const prevChain = orderChain[i-1];
      const chain = orderChain[i];
      const nextChain = orderChain[i+1];

      switch (chain.symbolWithDirection.direction) {
        case 'sell':
          if (!nextChain) {
            // console.log({nonext: true, chain});
            const prevAmount = prevChain.symbolWithDirection.direction === 'buy' ? 
              prevChain.orderBook.amount.bid :
              prevChain.orderBook.amount.ask
            const amount = Math.min(prevAmount, chain.orderBook.amount.ask, units[chain.symbolWithDirection.targCurrency]);
            const price = chain.orderBook.price.ask;
            const cost = amount * price;
            const costWithFee = cost * tradingFeeRate;

            planToOrder.push({
              trade: 'sell',
              symbol: chain.symbolWithDirection.symbol,
              amount,
              price,
              cost,
              costWithFee
            });
            break;
          }
          switch (nextChain.symbolWithDirection.direction) {
            case 'buy':
              // same as sellsell
              // console.log({selbuy: true, chain, nextChain})
              const amount = Math.min(
                units[chain.symbolWithDirection.targCurrency],
                chain.orderBook.amount.ask
              );
              const price = chain.orderBook.price.ask;
              const cost = amount * price;
              const costWithFee = cost * tradingFeeRate;

              planToOrder.push({
                trade: 'sell',
                symbol: chain.symbolWithDirection.symbol,
                amount,
                price,
                cost,
                costWithFee
              });
              break;
            case 'sell':
              // console.log({selsel: true, chain, nextChain});
              {
                const amount = Math.min(
                  units[chain.symbolWithDirection.targCurrency],
                  chain.orderBook.amount.ask
                );
                const price = chain.orderBook.price.ask;
                const cost = amount * price;
                const costWithFee = cost * tradingFeeRate;
                planToOrder.push({
                  trade: 'sell',
                  symbol: chain.symbolWithDirection.symbol,
                  amount,
                  price,
                  cost,
                  costWithFee
                });
              }
              break;
            default:
              break;
          }
          break;
        case 'buy':
          if (!nextChain) {
            // first buy
            const amount = Math.min(chain.orderBook.amount.bid, units[chain.symbolWithDirection.targCurrency]);
            const price = chain.orderBook.price.bid;
            const cost = amount * price;
            const costWithFee = cost * tradingFeeRate;
            planToOrder.push({
              trade: 'buy',
              symbol: chain.symbolWithDirection.symbol,
              amount,
              price ,
              cost,
              costWithFee
            });
            break;
          };
          switch (nextChain.symbolWithDirection.direction) {
            case 'buy':
              // console.log({buybuy: true, chain, nextChain})
              const nextChainAmount = Math.min(nextChain.orderBook.amount.bid, units[nextChain.symbolWithDirection.targCurrency]);
              const amount = Math.min(nextChainAmount * nextChain.orderBook.price.bid, units[chain.symbolWithDirection.targCurrency])
              const price = chain.orderBook.price.bid;
              const cost = amount * price;
              const costWithFee = cost * tradingFeeRate;
              planToOrder.push({
                trade: 'buy',
                symbol: chain.symbolWithDirection.symbol,
                amount,
                price,
                cost,
                costWithFee 
              });
              break;
            case 'sell':
              // console.log({buysel: true, chain, nextChain})
              {
                const amount = Math.min(chain.orderBook.amount.bid, nextChain.orderBook.amount.ask, units[chain.symbolWithDirection.targCurrency]);
                const price = chain.orderBook.price.bid;
                const cost = amount * price;
                const costWithFee = cost * tradingFeeRate;
                planToOrder.push({
                  trade: 'buy',
                  symbol: chain.symbolWithDirection.symbol,
                  amount,
                  price,
                  cost,
                  costWithFee
                });
              }
              break;
            default:
              break;
          }
          break;
        default:
          break;
      }
    }
    console.log(planToOrder);
    // estimate
    const firstOrder = planToOrder[0];
    const lastOrder = planToOrder.slice(-1)[0];
    const benefit = lastOrder.cost - firstOrder.cost;
    // if (benefit > leastAmount) {
    if (benefit > 1) {
      // and order
      webhookSend(planToOrder, benefit);
      planToOrder.forEach(order => {
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

    if (symbol === 'BTC/JPY') {
      console.log(routes);
      await estimateAndOrder(routes, []);
    }
  };
  functions.logger.info("fin: innerArbitrage", {});
}

async function webhookSend(orders, benefit) {
  const balance = await bitbank.fetchBalance()
  let attachments = orders.map(order => {
    return {
      color: 'good',
      fields: [
        {
          title: order.symbol,
          value: 'amount: ' + order.amount + '\n'
            + 'cost: ' + order.cost + '\n' 
            + 'price: ' + order.price + '\n' 
            + 'trade: ' + order.trade + '\n' 
            // + 'fee: ' + chancePair.root.fee
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
    text: 'Result: ' + benefit + ' yen'
      + '\n JPY: ' + balance.total.JPY + ' yen',
    attachments
  });
}

async function trade(order) {
  functions.logger.info("invoked: -- trade", order);
  switch (order.trade) {
    case 'sell':
      bitbank.createLimitSellOrder(order.symbol, order.amount, order.price)
      break;
    case 'buy':
      bitbank.createLimitBuyOrder(order.symbol, order.amount, order.price)
      break;
    default:
      break;
  }
  console.log(order);
  functions.logger.info("fin: -- trade", {});
}


