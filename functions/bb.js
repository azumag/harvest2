const functions = require("firebase-functions");
const admin = require("firebase-admin");
const ccxt = require('ccxt');
const { firebaseConfig } = require("firebase-functions");
const { IncomingWebhook } = require('@slack/webhook');

const period = 20;
const sigma = 2;
const feeRate = 0.0012;

const limitJPY = process.env.limitJPY ? parseInt(process.env.limitJPY) : 500;
const leastAmount = process.env.leastAmount ? parseFloat(process.env.leastAmount) : 0.0001;
const symbol = process.env.symbol ? process.env.symbol : 'BTC/JPY';
const exchangeId = process.env.exchangeId ? process.env.exchangeId : 'bitbank';

const exchange = new ccxt[exchangeId];
exchange.apiKey = functions.config()[exchangeId] ? 
  functions.config()[exchangeId].apikey 
  : process.env.apikey;
exchange.secret = functions.config()[exchangeId] ?
  functions.config()[exchangeId].secret 
  : process.env.secret;

/// prepare slack webhook
const url = functions.config().slack ? functions.config().slack : process.env.slack;
const webhook = url ? new IncomingWebhook(url) : null;

if (process.env.apikey) {
  callMain();
}

async function callMain() {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: firebaseConfig.databaseURL
  })
  try {
    await onTickExport();
  } catch (e) {
    webhook.send({
      username: 'Harvest 2: BB',
      icon_emoji: ':moneybag:',
      text: 'ERROR: ' + exchangeId + ' : ' + symbol + ' : ' + e,
      attachments: [
        {
          color: 'danger',
          fields: [
            {
              title: 'stacktrace',
              value: e.stack
            }
          ] 
        }
      ]
    });
  }
}

/// ======= Main ==========
async function onTickExport() {
  functions.logger.info("invoked", {symbol});
  const tickerHistories = await getTickers(period);
  const currentTicker = await recordTicker();
  if (tickerHistories === undefined) {

  } else {
    console.log(tickerHistories);
    await BBSignalOrder(tickerHistories, currentTicker);
  }
  console.log({symbol, leastAmount, limitJPY, period, sigma});
  functions.logger.info("fin", {exchangeId});
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

  const price = (exchangeId === 'bitflyer') ? 0 : bbResultCurrent.last
  if (bbResultBeforeTop < bbResultHistories.last) {
    if (bbResultCurrentTop > bbResultCurrent.last) {
      // sell
      const amount = await calcSellAmount();
      await exchange.createOrder(symbol, 'market', 'sell', amount, price);
      await webhookCommandSend({...status, trade: 'sell', amount});
      await recordSellBenefit(bbResultCurrent.last, amount);
    }
  }

  if (bbResultBeforeBottom > bbResultHistories.last) {
    if (bbResultCurrentBottom < bbResultCurrent.last) {
      // buy
      const amount = calcBuyAmont(bbResultCurrent.last);
      await exchange.createOrder(symbol, 'market', 'buy', amount, price);
      await recordBuyOrder(bbResultCurrent.last, amount);
      webhookCommandSend({...status, trade: 'buy', amount});
    }
  }
}

function calcBuyAmont(price) {
  if (limitJPY === undefined) {
    const bitfFee = (leastAmount * 0.0015);
    return (exchangeId === 'bitflyer') ? leastAmount + (bitfFee * 2) : leastAmount;
  }
  const amount = limitJPY / price;
  switch (exchangeId) {
    case 'bitbank':
      return amount;
      break;
    case 'bitflyer':
      const bitfFee = (amount * 0.0015);
      return amount + (bitfFee * 2);
      break;
    default:
      return undefined;
  }
}

async function calcSellAmount() {
  const buyTrade = await getBuyTrade();
  if (buyTrade === undefined) {
    return leastAmount;
  }
  switch (exchangeId) {
    case 'bitbank':
      return buyTrade.amount;
    case 'bitflyer':
      return buyTrade.amount - (buyTrade.amount * bitfFee);
    default:
      return undefined
  }
}

async function getBuyTrade() {
  const query = await admin
    .firestore()
    .collection('exchanges')
    .doc(exchangeId)
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
  return query.docs[0].data();
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

async function recordSellBenefit(last, amount) {
  const buyTrade = await getBuyTrade()
  if (buyTrade === undefined) {
    return;
  }
  const buycost  = buyTrade.amount * buyTrade.last;
  const sellcost = amount * last;
  const benefit = sellcost - (buycost + (buycost * feeRate)) - (sellcost * feeRate);

  const result = await admin
    .firestore()
    .collection('exchanges')
    .doc(exchangeId)
    .collection('symbols')
    .doc(symbol.replace('/','_'))
    .collection('results')
    .add({
      buyAmount: buyTrade.amount,
      sellAmount: amount,
      buyPrice: buyTrade.last,
      sellPrice: last,
      benefit,
      timestamp: new Date()
    });
  console.log(result);

  await webhookBenefitSend({
    benefit,
    sell: (amount * last),
    buy: (buyTrade.amount * buyTrade.last),
  })

  const deleteQuery = await admin
    .firestore()
    .collection('exchanges')
    .doc(exchangeId)
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
      .doc(exchangeId)
      .collection('symbols')
      .doc(symbol.replace('/','_'))
      .collection('buyTrades')
      .doc(delid)
      .delete();
    console.log(doDeleteQuery);
  }

}

async function recordBuyOrder(last, amount) {
  const result = await admin
    .firestore()
    .collection('exchanges')
    .doc(exchangeId)
    .collection('symbols')
    .doc(symbol.replace('/','_'))
    .collection('buyTrades')
    .add({
      amount: amount,
      last,
      timestamp: new Date()
    });

    console.log(result);
}

async function recordTicker() {
  const ticker = await exchange.fetchTicker(symbol);
  console.log(ticker);
  const result = await admin
    .firestore()
    .collection('exchanges')
    .doc(exchangeId)
    .collection('symbols')
    .doc(symbol.replace('/','_'))
    .collection('tickers')
    .add({
      last: ticker.last,
      high: ticker.high ? ticker.high : null,
      low: ticker.low ? ticker.low : null,
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
    .doc(exchangeId)
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
    text: 'Benefit: ' + status.benefit,
    attachments:[
      {
        color: 'danger',
        fields: [
          {
            title: 'Benefit: ' + status.benefit + " " + symbol,
            value: 'exchange : ' + exchangeId
              + '\n ' + 'buy: ' + status.buy
              + '\n ' + 'sell: ' + status.sell
          }
        ] 
      }
    ]
  });
}

async function webhookCommandSend(status) {
  const balance = await exchange.fetchBalance();
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
            + 'amount: ' + status.amount + '\n' 
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
      exchangeId + ` `
      + status.trade +  ' ' 
      + (status.currentLast * status.amount) 
      + " " + symbol,
    attachments
  });
}