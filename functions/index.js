const functions = require("firebase-functions");
// const admin = require("firebase-admin");
const ccxt = require('ccxt')

exports.onTick = functions
  .region('asia-northeast1')
  .pubsub.schedule('* * * * *')
  .timeZone('Asia/Tokyo')
  .onRun(async _ => await onTickExport())

const leastAmount = 0.0001;
const tradingFee = 0.0012;
const thresholdBenefit = 1;
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
  // 'BCC/BTC',
  'MONA/BTC',
  'XLM/BTC',
  'QTUM/BTC',
  'BAT/BTC',
];

const bitbank = new ccxt.bitbank();

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
      const midSymbol = midPairs[i];
      const midTargCurrency = midSymbol.match(/(.+)\//)[1];
      const goalSymbol = midTargCurrency + '/' + rootCurrency;

      const rootAskBid = await getAskBid(symbol)
      const midAskBid = await getAskBid(midSymbol)
      const goalAskBid = await getAskBid(goalSymbol);

      const midResult = (1/midAskBid.bid);
      const result = goalAskBid.ask * midResult;
      const total = result - rootAskBid.bid;
      const ActualTotal = total * leastAmount;

      const output = {
        currencies: [
          rootCurrency, midTargCurrency, targCurrency
        ],
        askbids: [
          rootAskBid.bid,
          midAskBid.bid,
          goalAskBid.ask
        ],
        midResult,
        result,
        total,
        ActualTotal,
      };
      if (output.ActualTotal >= thresholdBenefit) {
        chancePairs.push(output);
      }
    };
  };
  console.log(chancePairs);
}

onTickExport();

