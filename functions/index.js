// Example from https://firebase.google.com/docs/auth/admin/custom-claims

"use strict";

// The Cloud Functions for Firebase SDK to create
// Cloud Functions and setup triggers.
const functions = require("firebase-functions");

// The Firebase Admin SDK to access Firestore.
const admin = require("firebase-admin");
admin.initializeApp();

const { customAlphabet } = require("nanoid");
const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const nanoid = customAlphabet(alphabet, 12);

exports.replenishActivationCodes = functions.database
  .ref("/activation-codes/{used_code}")
  .onDelete((snapshot, context) => {
    const usedCode = context.params.used_code;

    return snapshot.ref.parent
      .once("value")
      .then((dataSnapshot) => {
        const limit = 10;
        if (Object.keys(dataSnapshot.val()).length >= limit) {
          const errMsg =
            "Reaching the maximum number of unused activation codes at once: " +
            limit;
          functions.logger.warn(errMsg);
          return Promise.reject(new Error(errMsg));
        }

        let generatedCode = nanoid();
        let retry = 0;
        while (retry < 3 && generatedCode === usedCode) {
          retry++;
          generatedCode = nanoid();
        }

        if (retry >= 3) {
          const errMsg =
            "Cannot generate a new code that's different from the old one: " +
            generatedCode;
          functions.logger.error(errMsg);
          return Promise.reject(new Error(errMsg));
        }

        functions.logger.log(
          "Activation code used: ",
          usedCode,
          "Replenishing by 1: ",
          generatedCode
        );

        // You must return a Promise when performing asynchronous tasks
        // inside a Functions such as writing to Firestore.
        return snapshot.ref.parent
          .child(generatedCode)
          .set({ "reserved-for-uid": "" });
      })
      .catch((error) => {
        return error;
      });
  });

// On sign up.
exports.addClaimsToNewUsers = functions.auth.user().onCreate((user) => {
  let customClaims;
  // Check if user meets role criteria.
  if (user.uid && user.email) {
    customClaims = {
      could_see_admin: true,
      admin_activated: false,
    };
  } else if (user.uid && user.phoneNumber) {
    customClaims = {
      could_see_admin: false,
      admin_activated: false,
    };
  }

  functions.logger.debug(
    "UID: ",
    user.uid,
    "Email: ",
    user.email,
    "Phone number: ",
    user.phoneNumber,
    "Custom claims: ",
    JSON.stringify(customClaims)
  );

  // Set custom user claims on this newly created user.
  return admin.auth().setCustomUserClaims(user.uid, customClaims);
  // .then(() => {
  //   // Update real-time database to notify client to force refresh.
  //   const metadataRef = admin.database().ref("metadata/" + user.uid);
  //   // Set the refresh time to the current UTC timestamp.
  //   // This will be captured on the client to force a token refresh.
  //   return metadataRef.set({ refreshTime: new Date().getTime() });
  // })
  // .catch((error) => {
  //   console.log(error);
  //   return error;
  // });
});

// activate an admin user
exports.activateAdminUser = functions.https.onCall((data, context) => {
  // activation code passed from the client.
  const suppliedCode = data.suppliedActivationCode;
  // Authentication / user information is automatically added to the request.
  const uid = context.auth.uid;

  // Checking attribute.
  if (typeof suppliedCode != "string" || suppliedCode.length != 12) {
    // Throwing an HttpsError so that the client gets the error details.
    throw new functions.https.HttpsError(
      "invalid-argument",
      "The function must be called with " +
        'one arguments "suppliedCode" containing the activation code.'
    );
  }
  // Checking that the user is authenticated.
  if (!context.auth) {
    // Throwing an HttpsError so that the client gets the error details.
    throw new functions.https.HttpsError(
      "failed-precondition",
      "The function must be called while authenticated."
    );
  }

  // Saving the new message to the Realtime Database.
  const activationCodeRef = admin
    .database()
    .ref("/activation-codes/" + suppliedCode); // Sanitize the message.

  return activationCodeRef
    .once("value")
    .then((dataSnapshot) => {
      if (dataSnapshot.val() === null) {
        throw new functions.https.HttpsError(
          "not-found",
          "This activation code doesn't appear to be valid."
        );
      }

      const reservedForUid = dataSnapshot.val()["reserved-for-uid"];
      if (reservedForUid !== uid) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "You are using an activation code that's intended for another account. " +
            "Please report this error to the website owner " +
            "and include the following information: " +
            " UID: " +
            uid +
            " Activation Code: " +
            suppliedCode
        );
      }

      const customClaims = {
        could_see_admin: true,
        admin_activated: true,
      };

      return admin.auth().setCustomUserClaims(uid, customClaims);
    })
    .then(() => {
      return activationCodeRef.remove();
    })
    .then(() => {
      return admin
        .database()
        .ref("/unverified-admins/" + uid)
        .remove();
    })
    .then(() => {
      const successMsg =
        "Activated uid " + uid + "with activation code " + suppliedCode;
      functions.logger.log(successMsg);
      return { activated: true };
    })
    .catch((error) => {
      // Re-throwing the error as an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError(error.code, error.message, error);
    });
});
