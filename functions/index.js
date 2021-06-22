const functions = require("firebase-functions");

const admin = require("firebase-admin");

const ccxt = require ('ccxt')

exports.onTick = functions
  .region('asia-northeast1')
  .pubsub.schedule('* * * * *')
  .timeZone('Asia/Tokyo')
  .onRun(async _ => await onTickExport())

async function onTickExport() {
  functions.logger.info("Hello logs!", {structuredData: ccxt.exchanges});
}