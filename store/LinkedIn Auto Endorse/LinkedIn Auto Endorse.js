// Phantombuster configuration {
"phantombuster command: nodejs"
"phantombuster package: 5"
"phantombuster dependencies: lib-StoreUtilities.js, lib-LinkedIn.js, lib-LinkedInScraper.js"

const Buster = require("phantombuster")
const buster = new Buster()

const Nick = require("nickjs")
const nick = new Nick({
	loadImages: true,
	userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.12; rv:54.0) Gecko/20100101 Firefox/54.0",
	printPageErrors: false,
	printResourceErrors: false,
	printNavigation: false,
	printAborts: false,
})

const StoreUtilities = require("./lib-StoreUtilities")
const utils = new StoreUtilities(nick, buster)
const Papa = require("papaparse")
const LinkedIn = require("./lib-LinkedIn")
const linkedIn = new LinkedIn(nick, buster, utils)

const LinkedInScraper = require("./lib-LinkedInScraper")
let linkedInScraper

/* global $ */

// }

const DB_NAME = "database-linkedin-auto-endorse.csv"

/**
 * CSS selectors used during the auto endorse process
 */
const SELECTORS_2 = {
	"endorseItem": ".pv-skill-category-entity",
	"endorseBtn": "button.pv-skill-entity__featured-endorse-button-shared",
	"skillText": ".pv-skill-category-entity__name span"
}

const SELECTORS_1 = {
	"endorseItem": ".pv-skill-entity--featured",
	"endorseBtn": ".pv-skill-entity__featured-endorse-button-shared",
	"skillText": ".pv-skill-entity__skill-name"
}

const SPINNER_SELECTOR = "li-icon > .artdeco-spinner"

/**
 * @async
 * @description Function used to open a LinkedIn profile in the given Nickjs tab
 * @param {Object} tab - Nickjs tab object
 * @param {String} url - URL to open
 * @throws if the tab didn't open the given profile
 */
const profileOpen = async (tab, url) => {
	await tab.open(url)
	try {
		await tab.waitUntilVisible("#extended-nav", 15000)
	} catch (err) {
		throw "Couldn't open LinkedIn profile"
	}
}

/**
 * @async
 * This function doesn't guarranty that the content of all profile sections
 * are totally loaded, for now use a custom handler to wait that data of a section is loaded
 * @description Function used to scroll to the bottom of a profile
 * @param {Object} tab - nickjs tab object
 */
const scrollDown = async (tab) => {
	utils.log("Scrolling down...", "loading")
	await tab.scroll(0, 1000)
	await tab.scroll(0, 2000)
	await tab.scroll(0, 3000)
	await tab.scroll(0, 4000)
	await tab.scrollToBottom()
	await tab.wait(3000)
	await tab.scrollToBottom()
	await tab.wait(3000)
	await tab.scrollToBottom()
	await tab.wait(1000)
}

/**
 * @description Browser context function used to endorse & retrieve all skills endorsed
 * @param {Object} argv
 * @param {Fucntion} cb
 */
const endorseProfile = (argv, cb) => {
	const MAX_ENDORSES = 3
	let data = []

	$(argv.selectors.endorseItem).each((index, element) => {
		// Prevent to endorse more than 3 skills, if there are more 3 skills at screen
		if (index < MAX_ENDORSES) {
			$(argv.selectors.endorseBtn).click()
			data[index] = $(element).find($(argv.selectors.skillText)).text()
		}
	})
	cb(null, data)
}

/**
 * This function is used to wait a bit more the loading of a section
 * @description Browser context function used to jump to each spinner in order to force the loading
 * @param {String} argv.spinner - LinkedIn loading spinner selector
 * @param {Function} cb - Function to exit browser context
 * @return {Boolean} always true
 */
const scrollToSpinners = (argv, cb) => {
	Array.from(document.querySelectorAll(argv.spinner)).map(el => el.scrollIntoView())
	cb(null, true)
}

/**
 * @description Main function that launch everything
 */
nick.newTab().then(async (tab) => {
	const [ sessionCookie, spreadsheetUrl, numberOfEndorsePerLaunch, columnName, hunterApiKey, disableScraping ] = utils.checkArguments([
		{name: "sessionCookie", type: "string", length: 10},
		{name: "spreadsheetUrl", type: "string", length: 10},
		{name: "numberOfEndorsePerLaunch", type: "number", default: 10},
		{name: "columnName", type: "string", default: ""},
		{ name: "hunterApiKey", type: "string", default: "" },
		{ name: "disableScraping", type: "boolean", default: true }
	])

	const db = await utils.getDb(DB_NAME)
	const data = await utils.getDataFromCsv(spreadsheetUrl, columnName)
	let profileUrls = data.filter(el => db.findIndex(line => el === line.url || linkedIn.getUsername(el) === linkedIn.getUsername(line.url)) < 0).slice(0, numberOfEndorsePerLaunch)

	if (profileUrls.length < 1) {
		utils.log("Spreadsheet is empty or everyone is already endorsed from this sheet.", "warning")
		nick.exit()
	}

	linkedInScraper = new LinkedInScraper(utils, hunterApiKey || null, nick)
	let selectorFound
	let skills
	const result = []

	await linkedIn.login(tab, sessionCookie)

	for (const url of profileUrls) {
		if (url.indexOf("http://") === -1 && url.indexOf("https://") === -1) {
			utils.log("Skipping entry because it doesn't look valid (\"" + url + "\")", "warning")
			continue
		}
		utils.log("Opening LinkedIn profile (" + url + ")", "loading")
		try {
			let res = {}
			const scrapingUrl = await linkedInScraper.salesNavigatorUrlConverter(url)
			if (!disableScraping) {
				const tmp = await linkedInScraper.scrapeProfile(tab, scrapingUrl)
				res = Object.assign({}, tmp.csv)
			} else {
				await profileOpen(tab, scrapingUrl)
				await scrollDown(tab)
				/**
				 * In order to load the entire content of all sections
				 * we need to scroll to each section and wait that the loading spinner dismiss
				 * It should be a better & cleaner way to get rid of those spinners, we're working on it !
				 */
				if (await tab.isPresent(SPINNER_SELECTOR)) {
					await tab.evaluate(scrollToSpinners, { spinner: SPINNER_SELECTOR })
					await tab.waitWhileVisible(SPINNER_SELECTOR, 15000)
				}
			}
			await tab.inject("../injectables/jquery-3.0.0.min.js")
			try {
				selectorFound = await tab.waitUntilVisible([SELECTORS_1.endorseItem, SELECTORS_2.endorseItem], 15000, "or")
			} catch (e) {
				utils.log("Could not find skills to endorse on this profile page", "info")
				db.push({ url }) // add to db anyway, we're not going to reprocess someone that has no skills
				continue
			}

			if (selectorFound === SELECTORS_1.endorseItem) {
				skills = await tab.evaluate(endorseProfile, { selectors: SELECTORS_1})
			} else {
				skills = await tab.evaluate(endorseProfile, { selectors: SELECTORS_2 })
			}

			utils.log("Endorsed " + skills.join(", "), "info")
			res = Object.assign(res, { skills, url })
			result.push(res)
			db.push({ url })
		} catch (e) {
			utils.log(`Could not endorse profile "${url}": ${e.toString()}`, "warning")
		}
	}

	/**
	 * If the script is running in test mode,
	 * there is no need to save the data
	 */
	if (!utils.test) {
		await buster.saveText(Papa.unparse(db), DB_NAME)
	}
	utils.log(`Endorsed ${result.length} profiles.`, "done")
	await linkedIn.saveCookie()
	await utils.saveResult(result)
})
.catch((err) => {
	console.log(err)
	nick.exit(1)
})
