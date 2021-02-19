/* eslint-disable require-jsdoc */
const functions = require("firebase-functions");
const admin = require("firebase-admin");

const VoiceResponse = require("twilio").twiml.VoiceResponse;

const callFromNumber = functions.config().twilio.call_from_number;

exports.userVoiceResponseHandler = functions.https.onRequest((req, res) => {
  const twiml = new VoiceResponse();

  const dbListener = admin
    .database()
    .ref("/activeCalls/" + req.body.CallSid + "/userInput");

  // helper to respond with the current TwiML content
  function respond() {
    res.type("text/xml");
    res.send(twiml.toString());
  }

  /** helper function to set up a <Gather> */
  function gather() {
    const gatherNode = twiml.gather({ timeout: 10, numDigits: 1 });
    gatherNode.say(
      { voice: "man" },
      "Hello, this is Easy Wait List, calling you about an available co-vid vaccine appointment immediately." +
        "Press one to confirm that you can show up in the next twenty minutes." +
        "Press two to decline and ramin on the waitlist."
    );

    // If the user doesn't enter input, loop
    // TODO: actually hang up here
    twiml.redirect("/twilioConnector");
  }

  if (req.body.From !== callFromNumber) {
    twiml.say("This number is only for notifications. Goodbye!");
    twiml.hangup();
  } else {
    // If the user entered digits, process their request
    if (req.body.Digits) {
      switch (req.body.Digits) {
        case "1":
          // TODO: Watch out for async not finishing before the call ends
          dbListener.set("confirmed");
          twiml.say(
            { voice: "man" },
            "You have confirmed. A clinic staff will reach out to you soon."
          );
          twiml.hangup();
          break;
        case "2":
          // TODO: Watch out for async not finishing before the call ends
          dbListener.set("declined");
          twiml.say(
            { voice: "man" },
            "You have declined. We will remove your waitlist information."
          );
          twiml.hangup();
          break;
        default:
          twiml.say("Sorry, I don't understand that choice.").pause();
          gather();
          break;
      }
    } else {
      // If no input was sent, use the <Gather> verb to collect user input
      gather();
    }
  }

  respond();
});
