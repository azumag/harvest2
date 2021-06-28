const functions = require("firebase-functions");
const admin = require("firebase-admin");
const ccxt = require('ccxt');
const { firebaseConfig } = require("firebase-functions");
const { IncomingWebhook } = require('@slack/webhook');

const period = 20;
const sigma = 2;
const leastAmount = process.env.leastAmount ? process.env.leastAmount : 0.0001;
const symbol = process.env.symbol ? process.env.symbol : 'BTC/JPY';

const bitbank = new ccxt.bitbank();
bitbank.apiKey = functions.config().bitbank ? functions.config().bitbank.apikey : process.env.apikey;
bitbank.secret = functions.config().bitbank ? functions.config().bitbank.secret : process.env.secret;

/// prepare slack webhook
const url = functions.config().slack ? functions.config().slack : process.env.slack;
const webhook = url ? new IncomingWebhook(url) : null;

if (process.env.apikey) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: firebaseConfig.databaseURL
  })
  onTickExport();
}

async function onTickExport() {
  functions.logger.info("invoked", {symbol});
  const tickerHistories = await getTickers(period);
  const currentTicker = await recordTicker();
  if (tickerHistories === undefined) {

  } else {
    console.log(tickerHistories);
    await BBSignalOrder(tickerHistories, currentTicker);
  }
  console.log({symbol, leastAmount, period, sigma});
  functions.logger.info("fin", {});
}

async function BBSignalOrder(tickerHistories, currentTicker) {
  const bbResultHistories = BB(tickerHistories);
  tickerHistories.pop();
  tickerHistories.unshift(currentTicker);
  const bbResultCurrent = BB(tickerHistories);

  const bbResultBeforeTop    = bbResultHistories.average + (sigma * bbResultHistories.standardDeviation);
  const bbResultBeforeBottom = bbResultHistories.average - (sigma * bbResultHistories.standardDeviation);

  const bbResultCurrentTop    = bbResultCurrent.average + (sigma * bbResultHistories.standardDeviation);
  const bbResultCurrentBottom = bbResultCurrent.average - (sigma * bbResultHistories.standardDeviation);

  const status = {
    bbResultBeforeTop,
    bbResultBeforeBottom,
    bbResultCurrentTop,
    bbResultCurrentBottom,
    beforeLast: bbResultHistories.last,
    currentLast: bbResultCurrent.last,
  };
  console.log(status);

  if (bbResultBeforeTop < bbResultHistories.last) {
    if (bbResultCurrentTop > bbResultCurrent.last) {
      // sell
      await bitbank.createOrder(symbol, 'market', 'sell', leastAmount, bbResultCurrent.last);
      webhookCommandSend({...status, trade: 'sell'});
      await recordSellBenefit(bbResultCurrent.last);
    }
  }

  if (bbResultBeforeBottom > bbResultHistories.last) {
    if (bbResultCurrentBottom < bbResultCurrent.last) {
      // buy
      await bitbank.createOrder(symbol, 'market', 'buy', leastAmount, bbResultCurrent.last);
      await recordBuyOrder(bbResultCurrent.last);
      webhookCommandSend({...status, trade: 'buy'});
    }
  }
}

function BB(tickers) {
  const lasts = tickers.map(ticker => {
    return ticker.last;
  });

  const average = lasts.reduce((previous, current) =>
    previous + current
  ) / lasts.length; 

  const standardDeviation = Math.sqrt(
    lasts.map((current) => {
        let difference = current - average;
        return difference ** 2;
    })
    .reduce((previous, current) =>
        previous + current
    ) / lasts.length
  );

  return {last: lasts[0], average, standardDeviation};
}

async function recordSellBenefit(last) {
  const query = await admin
    .firestore()
    .collection('exchanges')
    .doc('bitbank')
    .collection('symbols')
    .doc(symbol.replace('/','_'))
    .collection('buyTrades')
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  if (query.empty || query.docs === undefined) {
    return undefined;
  }

  console.log(query);

  const buyTrade = query.docs[0].data();

  // TODO: calc trade fee
  const benefit = (leastAmount * last) - (buyTrade.amount * buyTrade.last);

  const result = await admin
    .firestore()
    .collection('exchanges')
    .doc('bitbank')
    .collection('symbols')
    .doc(symbol.replace('/','_'))
    .collection('results')
    .add({
      buyAmount: parseFloat(leastAmount),
      sellAmount: parseFloat(leastAmount),
      buyPrice: buyTrade.last,
      sellPrice: last,
      benefit,
      timestamp: new Date()
    });
  console.log(result);

  await webhookBenefitSend({
    benefit,
    sell: (leastAmount * last),
    buy: (buyTrade.amount * buyTrade.last),
  })

  const deleteQuery = await admin
    .firestore()
    .collection('exchanges')
    .doc('bitbank')
    .collection('symbols')
    .doc(symbol.replace('/','_'))
    .collection('buyTrades')
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  if (deleteQuery.empty || deleteQuery.docs === undefined) {
    return undefined;
  }

  const delid = deleteQuery.docs[0].id;

  console.log({delid});

  if (delid) {
    const doDeleteQuery = await admin
      .firestore()
      .collection('exchanges')
      .doc('bitbank')
      .collection('symbols')
      .doc(symbol.replace('/','_'))
      .collection('buyTrades')
      .doc(delid)
      .delete();
    console.log(doDeleteQuery);
  }

}

async function recordBuyOrder(last) {
  const result = await admin
    .firestore()
    .collection('exchanges')
    .doc('bitbank')
    .collection('symbols')
    .doc(symbol.replace('/','_'))
    .collection('buyTrades')
    .add({
      amount: parseFloat(leastAmount),
      last,
      timestamp: new Date()
    });

    console.log(result);
}

async function recordTicker() {
  const ticker = await bitbank.fetchTicker(symbol);
  console.log(ticker);
  const result = await admin
    .firestore()
    .collection('exchanges')
    .doc('bitbank')
    .collection('symbols')
    .doc(symbol.replace('/','_'))
    .collection('tickers')
    .add({
      last: ticker.last,
      high: ticker.high,
      low: ticker.low,
      ask: ticker.ask,
      bid: ticker.bid,
      timestamp: new Date(ticker.timestamp)
    });

    console.log(result);
  return ticker;
}
  
async function getTickers(period) {
  const query = await admin
    .firestore()
    .collection('exchanges')
    .doc('bitbank')
    .collection('symbols')
    .doc(symbol.replace('/','_'))
    .collection('tickers')
    .orderBy('timestamp', 'desc')
    .limit(period)
    .get();

  if (query.empty || query.docs === undefined) {
    return undefined;
  }

  return query.docs.map(doc => doc.data());
}

async function webhookBenefitSend(status) {
  return webhook.send({
    username: 'Harvest 2: BB',
    icon_emoji: ':moneybag:',
    text: 'Benefit: ' + status.benefit + " " + symbol
      + '\n ' + 'buy: ' + status.buy
      + '\n ' + 'sell: ' + status.sell
  });
}

async function webhookCommandSend(status) {
  const balance = await bitbank.fetchBalance();
  let attachments = [
    {
      color: 'good',
      fields: [
        {
          title: status.trade,
          value:
           'BeforeTop: ' + status.bbResultBeforeTop + '\n'
            + 'BeforeBottom: ' + status.bbResultBeforeBottom + '\n' 
            + 'CurrentTop: ' + status.bbResultCurrentTop + '\n' 
            + 'CurrentBottom: ' + status.bbResultCurrentBottom + '\n' 
            + 'BeforeLast: ' + status.beforeLast + '\n' 
            + 'CurrentLast: ' + status.currentLast + '\n' 
        }
      ]
    }
  ];
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
    username: 'Harvest 2: BB',
    icon_emoji: ':moneybag:',
    text: 
      status.trade +  ' ' 
      + (status.currentLast * leastAmount) 
      + " " + symbol,
    attachments
  });
}