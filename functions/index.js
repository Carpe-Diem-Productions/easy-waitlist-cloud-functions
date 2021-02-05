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

// This function detects if an activation code is deleted (in normal cases
// consumed by client side) and automatically generates a new un-used
// activation code, up to the <limit> number of unused activation codes
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

// This function adds custom claims to the new user account. Custom claims
// are secure and can be verified on the client side.
// Note: after setting a custom claim, it sets database location
// "metadata/{user.uid}/idTokenRefreshTime". This is how the client side
// will know that Cloud Functions has finished setting custom claims.
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
  return admin
    .auth()
    .setCustomUserClaims(user.uid, customClaims)
    .then(() => {
      // Update real-time database to notify client to force refresh.
      const metadataRef = admin.database().ref("metadata/" + user.uid);
      // Set the refresh time to the current UTC timestamp.
      // This will be captured on the client to force a token refresh.
      return metadataRef.set({ idTokenRefreshTime: new Date().getTime() });
    })
    .catch((error) => {
      functions.logger.error(error);
      return error;
    });
});

// This function takes in an activation code and attempts to activate
// an unverified admin user (in ohter words, modifying their custom claims).
// Conditions for activation:
// 1) Code must exists under /activation-codes
// 2) Code is reserved for a specific UID and can only activate that UID
exports.activateAdminUser = functions.https.onCall((data, context) => {
  // activation code passed from the client.
  const suppliedCode = data.suppliedActivationCode;

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
    throw new functions.https.HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  // Authentication / user information is automatically added to the request.
  const uid = context.auth.uid;

  const activationCodeRef = admin
    .database()
    .ref("/activation-codes/" + suppliedCode);

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

// This function returns the number of waitlisted users that fall in the zip code range
// For privacy reasons, I'm not returning the full waitlist details. Instead, I'm storing
// the details in the /admin/${uid}/waitlistSearchResult/, and only return the number
// of found matches. This way, after user consents to taking the waitlist spot, then
// I can share their full details with admin.
exports.getWaitlistedContacts = functions.https.onCall((data, context) => {
  // Checking that the user is authenticated.
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  // Authentication / user information is automatically added to the request.
  const adminUid = context.auth.uid;

  // What will be returned to admin
  const returnToAdmin = {
    numWaitlistRecordsFound: 0,
  };

  return admin
    .auth()
    .getUser(adminUid)
    .then((userRecord) => {
      const zipSearchRangeRef = admin
        .database()
        .ref("/admin/" + adminUid + "/zipSearchRange");

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

      return zipSearchRangeRef.once("value");
    })
    .then((dataSnapshot) => {
      if (dataSnapshot.val() === null) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "You haven't set a valid zip search range."
        );
      }

      const allZipCodes = dataSnapshot.val().split(",");
      const allPromises = [];
      // Asynchronously fire multiple database operations in parallel
      for (const oneZipCode of allZipCodes) {
        const p = admin
          .database()
          .ref("/zip/" + oneZipCode)
          .once("value");
        allPromises.push(p);
      }
      return Promise.all(allPromises);
    })
    .then((zipCodeSnapshots) => {
      const rawResults = [];
      zipCodeSnapshots.forEach((zipCodeSnap) => {
        if (zipCodeSnap.val() !== null) {
          rawResults.push(zipCodeSnap.val());
        }
      });

      const filteredResult = [];
      for (const result of rawResults) {
        for (const uid in result["uid"]) {
          if (Object.prototype.hasOwnProperty.call(result["uid"], uid)) {
            for (const wlKey in result["uid"][uid]["waitlistKey"]) {
              if (
                Object.prototype.hasOwnProperty.call(
                  result["uid"][uid]["waitlistKey"],
                  wlKey
                )
              ) {
                filteredResult.push(result["uid"][uid]["waitlistKey"][wlKey]);
              }
            }
          }
        }
      }

      returnToAdmin["numWaitlistRecordsFound"] = filteredResult.length;

      return admin
        .database()
        .ref("/admin/" + adminUid + "/waitlistSearchResult")
        .set({
          generatedAt: Date.now(),
          result: filteredResult,
        });
    })
    .then(() => {
      return returnToAdmin;
    })
    .catch((error) => {
      functions.logger.warn(error);
      // Re-throwing the error as an HttpsError so that the client gets the error details.
      throw new functions.https.HttpsError(error.code, error.message, error);
    });
});
