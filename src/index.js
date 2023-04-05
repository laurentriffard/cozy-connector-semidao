process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://7174302c2dd047ac98b1ab182f616f40@errors.cozycloud.cc/55'

const {
  BaseKonnector,
  requestFactory,
  scrape,
  log,
  cozyClient,
  utils
} = require('cozy-konnector-libs')
const crypto = require('crypto')

const request = requestFactory({
  // The debug mode shows all the details about HTTP requests and responses. Very useful for
  // debugging but very verbose. This is why it is commented out by default
  // debug: true,
  // Activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // This allows request-promise to keep cookies between requests
  jar: true
})

const VENDOR = 'semidao'
const baseUrl = 'https://agence-en-ligne.semidao.fr/wp/'
const loginUrl = baseUrl + 'home.action'
const billsUrl = baseUrl + 'displayBills.action'
const models = cozyClient.new.models
const { Qualification } = models.document

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
// cozyParameters are static parameters, independents from the account. Most often, it can be a
// secret api key.
async function start(fields, cozyParameters) {
  log('info', 'Authenticating ...')
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  await authenticate.bind(this)(fields.login, fields.password)
  log('info', 'Successfully logged in')
  // The BaseKonnector instance expects a Promise as return of the function
  log('info', 'Fetching the list of documents')
  const $ = await request(`${billsUrl}`)
  // cheerio (https://cheerio.js.org/) uses the same api as jQuery (http://jquery.com/)
  log('info', 'Parsing list of documents')
  const documents = await parseDocuments($)

  // Here we use the saveBills function even if what we fetch are not bills,
  // but this is the most common case in connectors
  log('info', 'Saving data to Cozy')
  await this.saveBills(documents, fields, {
    // This is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['semidao']
  })
}

// This shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
function authenticate(username, password) {
  const hashPassword = crypto.createHash('md5').update(password).digest('hex')
  return this.signin({
    url: loginUrl,
    formSelector: 'form',
    formData: { j_username: username, password: '', j_password: hashPassword },
    // The validate function will check if the login request was a success. Every website has a
    // different way to respond: HTTP status code, error message in HTML ($), HTTP redirection
    // (fullResponse.request.uri.href)...
    validate: (statusCode, $, fullResponse) => {
      log(
        'debug',
        fullResponse.request.uri.href,
        'not used here but should be useful for other connectors'
      )
      log('debug', $('.alertmsg').text())
      log(
        'debug',
        $('a[href="showDisplayBills.action"]').length,
        'number of href showDisplayBills.action'
      ) // should be 4
      log(
        'debug',
        $('div.fullpage.body.connected').length,
        'number of div body connected'
      )

      // return $('a[href="showDisplayBills.action"]').length > 0 || log('error', $('.alertmsg').text())
      return (
        $('div.fullpage.body.connected').length == 1 ||
        log('error', $('.alertmsg').text())
      )
    }
  })
}

// The goal of this function is to parse a HTML page wrapped by a cheerio instance
// and return an array of JS objects which will be saved to the cozy by saveBills
// (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
function parseDocuments($) {
  // You can find documentation about the scrape function here:
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape

  log(
    'debug',
    $('table#billTable tr').length,
    'in parseDocuments, number of rows'
  )
  const docs = scrape(
    $,
    {
      date: {
        // sel: 'td[aria-describedby="billTable_date"]',
        sel: 'td:nth-child(1)',
        parse: dateStr => {
          log('debug', dateStr, 'read date')
          // date format is "dd/mm/yyyy"
          var parts = dateStr.match(/(\d+)/g)
          return parts != null
            ? new Date(parts[2], parts[1] - 1, parts[0])
            : null
        }
      },
      vendorRef: {
        // sel: 'td[aria-describedby="billTable_ref"]',
        sel: 'td:nth-child(2)'
      },
      amount: {
        // sel: 'td[aria-describedby="billTable_amount"]',
        sel: 'td:nth-child(3)',
        parse: normalizePrice
      },
      fileurl: {
        // sel: 'td[aria-describedby="billTable_url"]',
        sel: 'td:nth-child(5) a',
        // attr: 'href',
        fn: $node => {
          log('debug', $node.attr('href'), 'fileurl href')
          if ($node.attr('href') == null) return null
          return `${baseUrl}` + $node.attr('href')
        }
      }
    },
    'table#billTable tr'
  )
  return docs.map(doc => ({
    ...doc,
    currency: 'EUR',
    filename: `${utils.formatDate(doc.date)}_${VENDOR}_${doc.amount}EUR${
      doc.vendorRef ? '_' + doc.vendorRef : ''
    }.pdf`,
    vendor: VENDOR,
    qualification: Qualification.getByLabel('water_invoice')
  }))
}

// Convert a price string to a float
function normalizePrice(price) {
  log('debug', price, 'in normalizePrice')
  return parseFloat(price.replace('€', '').trim())
}
