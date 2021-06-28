const admin = require("firebase-admin");

const { firebaseConfig } = require("firebase-functions");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: firebaseConfig.databaseURL
})

const symbol = 'QTUM/JPY'

a();

async function a() {
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

  console.log(deleteQuery);

  console.log(deleteQuery.docs[0]);
  console.log(deleteQuery.docs[0].data());
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