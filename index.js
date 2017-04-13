const express = require('express');
const resolve = require('path').resolve;
const ParseServer = require('parse-server').ParseServer;


const PORT = 1337;
const PARSE_SERVER = `http://localhost:${PORT}/parse`;
const MONGO_DB = `mongodb://127.0.0.1:27017/parse`;
const MAIN_SITE = `http://localhost:3000`;
module.exports['PARSE_SERVER'] = PARSE_SERVER;


const mailgunConfig = {
  fromAddress: "parse@charliedisney.com",
  domain: "charliedisney.com",
  apiKey: "key-6488b75d22dfe878cf83f1753d64f825"
};
module.exports.mailgunConfig = mailgunConfig;

const parseConfig = {
  appId: "d5701a37cf242d5ee398005d997e4229",
  masterKey: "5a70dd9922602c26e6fac84d611decb4",
  appName: "Chisel",
  cloud: "./cloud/main",
  databaseURI: MONGO_DB,
  
  serverURL: PARSE_SERVER,
  publicServerURL: PARSE_SERVER,
  
  verifyUserEmails: true,
  preventLoginWithUnverifiedEmail: true,
  
  emailAdapter: {
    module: "parse-server-mailgun",
    options: Object.assign(mailgunConfig, {
      templates: {
        passwordResetEmail: {
          subject: 'Reset your password',
          pathPlainText: resolve(__dirname, 'mailTemplates/passwordReset.txt'),
          pathHtml: resolve(__dirname, 'mailTemplates/passwordReset.html'),
        },
        verificationEmail: {
          subject: 'Confirm your account',
          pathPlainText: resolve(__dirname, 'mailTemplates/emailVerify.txt'),
          pathHtml: resolve(__dirname, 'mailTemplates/emailVerify.html')
        }
      }
    })
  },
  
  customPages: {
    verifyEmailSuccess:   `${MAIN_SITE}/email-verify`,
    choosePassword:       `${MAIN_SITE}/password-set`,
    passwordResetSuccess: `${MAIN_SITE}/password-set-success`,
    invalidLink:          `${MAIN_SITE}/invalid-link`
  }
};
module.exports.parseConfig = parseConfig;

const api = new ParseServer(parseConfig);

let app = new express();

// Serve the Parse API on the /parse URL prefix
app.use('/parse', api);

app.listen(PORT, () => {
  console.log(`Parse server running on port ${PORT}.`);
});