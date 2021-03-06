const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { firebaseConfig } = require("firebase-functions");
const { IncomingWebhook } = require('@slack/webhook');
const dayjs = require("dayjs");

const exchanges = [
  'bitbank',
  'bitflyer'
]

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
  'OMG/JPY',
  'XRP/BTC',
  'ETH/BTC',
  'LTC/BTC',
  'BCH/BTC',
  'MONA/BTC',
  'XLM/BTC',
  'QTUM/BTC',
  'BAT/BTC',
];

/// prepare slack webhook
const url = functions.config().slack ? functions.config().slack : process.env.slack;
const webhook = url ? new IncomingWebhook(url) : null;


const interval = process.env.interval ? process.env.interval : 'day'

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: firebaseConfig.databaseURL
})

onTickExport();

async function onTickExport() {
  functions.logger.info("invoked", {});

  // const since = dayjs().subtract(1, 'week');
  const since = dayjs().subtract(1, interval);

  exchanges.forEach(async (exchange) => {
    const benefits = (await Promise.all(currencyPairs.map(e => getBenefits(exchange, since, e))))
      .filter(Boolean);

    console.log(benefits);

    const sumBenefits = benefits.map(bf => {
      return { 
        symbol: bf.symbol,
        benefit: bf.benefits.reduce((a,b) => a+b)
      }
    })

    // console.log(sumBenefits)

    if (sumBenefits.length > 0) {
      const total = sumBenefits.reduce((a, b) => {
       return {benefit: a.benefit + b.benefit}
      });

      console.log({exchange, sumBenefits, total});

      await webhookSend(exchange, sumBenefits, total);

    }
  });

  functions.logger.info("fin", {});
}

async function getBenefits(exchange, since, symbol) {
  const query = await admin
    .firestore()
    .collection('exchanges')
    .doc(exchange)
    .collection('symbols')
    .doc(symbol.replace('/','_'))
    .collection('results')
    .where('timestamp', '>=', since.toDate())
    .get()
    // .add({
    //   buyAmount: parseFloat(leastAmount),
    //   sellAmount: parseFloat(leastAmount),
    //   buyPrice: buyTrade.last,
    //   sellPrice: last,
    //   benefit,
    //   timestamp: new Date()
    // });
  if (query.empty || query.docs === undefined) return null;
  return {symbol, benefits: (query.docs.map(e=>e.data().benefit))};
}

async function webhookSend(exchange, sumBenefits, total) {
  let attachments = sumBenefits.map((sb) => {
    return {
      color: 'good',
      fields: [
        {
          title: sb.symbol,
          value: sb.benefit
        }
      ]
    }
  });

  return webhook.send({
    channel: 'results_' + interval,
    username: 'Harvest 2: ' + interval + 'Results',
    icon_emoji: ':moneybag:',
    text: exchange + ' : ' + total.benefit + ' JPY', 
    attachments
  });
}