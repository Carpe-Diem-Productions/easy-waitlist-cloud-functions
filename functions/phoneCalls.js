/* eslint-disable require-jsdoc */
const functions = require("firebase-functions");

// The Firebase Admin SDK to access Firestore.
const admin = require("firebase-admin");

const accountSid = functions.config().twilio.account_sid;
const authToken = functions.config().twilio.auth_token;
const callFromNumber = functions.config().twilio.call_from_number;

const client = require("twilio")(accountSid, authToken);

/**
 * Confirm a user
 * @param {string}waitlistRecordKey Waitlist key associated with this record.
 * @return {boolean} User accepted via dial pad.
 */
async function confirmUser(waitlistRecordKey) {
  functions.logger.log("User confirmed: " + waitlistRecordKey);
}

/**
 * Cancel a user
 * @param {string}waitlistRecordKey Waitlist key associated with this record.
 * @return {boolean} User accepted via dial pad.
 */
async function cancelUser(waitlistRecordKey) {
  functions.logger.log("User cancelled: " + waitlistRecordKey);
}

/**
 * Use Twilio to call a number and get confirmation
 * @param {string}phoneNumber Phone number in string format.
 * @param {string}waitlistRecordKey Waitlist key associated with this record.
 * @return {boolean} User accepted via dial pad.
 */
async function doCallUser(phoneNumber, waitlistRecordKey) {
  try {
    const callInstance = await client.calls.create({
      url:
        "https://us-central1-easy-waitlist.cloudfunctions.net/twilioConnector",
      to: phoneNumber,
      from: callFromNumber,
    });

    functions.logger.info(
      "Initiating calls to " + phoneNumber + " call SID: " + callInstance.sid
    );

    const dbListener = admin.database().ref("/activeCalls/" + callInstance.sid);

    await dbListener.set({
      userNumber: phoneNumber,
      waitlistKey: waitlistRecordKey,
      userInput: "unknown",
    });

    const didUserRespond = new Promise((resolve, reject) => {
      setTimeout(() => {
        dbListener.off();
        dbListener.set(null);
        reject(new Error("Timed out after 60 seconds"));
      }, 60 * 1000);

      dbListener.on("value", (dataSnapshot) => {
        if (dataSnapshot.val().userInput === "confirmed") {
          confirmUser(waitlistRecordKey);
          dbListener.off();
          dbListener.set(null);
          resolve("confirmed");
        } else if (dataSnapshot.val().userInput === "cancelled") {
          cancelUser(waitlistRecordKey);
          dbListener.off();
          dbListener.set(null);
          resolve("cancelled");
        }
      });
    });

    return didUserRespond;
  } catch (error) {
    functions.logger.warn(error);
    throw error;
  }
}

exports.startCallingUsers = functions
  .runWith({ timeoutSeconds: 500 })
  .https.onCall(async (data, context) => {
    // Checking that the user is authenticated.
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "The function must be called while authenticated."
      );
    }

    // Authentication / user information is automatically added to the request.
    const adminUid = context.auth.uid;

    try {
      const userRecord = await admin.auth().getUser(adminUid);

      if (
        typeof userRecord.customClaims === "undefined" ||
        !userRecord.customClaims.could_see_admin ||
        !userRecord.customClaims.admin_activated
      ) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "You are not an activated admin."
        );
      }

      const callListDbRef = admin
        .database()
        .ref("/admin/" + adminUid + "/waitlistSearchResult");

      const dataSnapshot = await callListDbRef.once("value");
      const searchList = dataSnapshot.val();
      if (searchList === null) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "You haven't performed a search in the waitlist."
        );
      }

      if (searchList.length > data.numSpotsToFill) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "You can't call more users than what's in the search results."
        );
      }

      if (Date.now() - searchList.generatedAt > 1000 * 60 * 60 * 3) {
        throw new functions.https.HttpsError(
          "deadline-exceeded",
          "The search result from the wailist is more than 3 hours old. Please search again."
        );
      }

      const shuffledSearchList = shuffle(searchList.result);

      const confirmedList = [];

      let numConfirmed = 0;

      for (let i = 0; i < shuffledSearchList.length; i++) {
        const p = await doCallUser(
          shuffledSearchList[i].phoneNumber,
          shuffledSearchList[i].waitlistRecordKey
        );
        if (p === "confirmed") {
          numConfirmed++;
          confirmedList.push(shuffledSearchList[i]);
          if (numConfirmed >= data.numSpotsToFill) {
            break;
          }
        }
      }

      const cachedConfirmedList = {
        generatedAt: Date.now(),
        cachedConfirmedList: confirmedList,
      };

      await callListDbRef.child("cachedConfirmedList").set(cachedConfirmedList);

      return { confirmedList: confirmedList };
    } catch (error) {
      functions.logger.warn(error);
      // Re-throwing the error as an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError(error.code, error.message, error);
    }
  });

/**
 * Shuffle array in place using Fisher–Yates Shuffle.
 * Courtesy of https://bost.ocks.org/mike/shuffle/
 * @param {[]}array Array to shuffle.
 * @return {[]} Shuiffled array.
 */
function shuffle(array) {
  let m = array.length;
  let t;
  let i;

  // While there remain elements to shuffle…
  while (m) {
    // Pick a remaining element…
    i = Math.floor(Math.random() * m--);

    // And swap it with the current element.
    t = array[m];
    array[m] = array[i];
    array[i] = t;
  }

  return array;
}
