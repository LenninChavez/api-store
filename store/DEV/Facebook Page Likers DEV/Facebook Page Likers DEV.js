// Phantombuster configuration {
"phantombuster command: nodejs"
"phantombuster package: 5"
"phantombuster dependencies: lib-StoreUtilities.js, lib-Facebook-DEV.js"
"phantombuster flags: save-folder"

const Buster = require("phantombuster")
const buster = new Buster()

const Nick = require("nickjs")
const nick = new Nick({
	loadImages: false,
	userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.12; rv:54.0) Gecko/20100101 Firefox/54.0",
	printPageErrors: false,
	printResourceErrors: false,
	printNavigation: false,
	printAborts: false,
	debug: false,
})

const _ = require("lodash")
const cheerio = require("cheerio")
const URL = require("url").URL

const StoreUtilities = require("./lib-StoreUtilities")
const utils = new StoreUtilities(nick, buster)
const Facebook = require("./lib-Facebook-DEV")
const facebook = new Facebook(nick, buster, utils)    

// }

const retrieveAllPageUrls = async (result, agentObject, spreadsheetUrl, columnName) => {
	let pageUrls = []
	const inputUrl = new URL(spreadsheetUrl)
	if (inputUrl.hostname.toLowerCase().includes("facebook.com")) { // facebook page
		let pageUrl = utils.adjustUrl(spreadsheetUrl, "facebook")
			if (!pageUrl) {	
				utils.log("The given url is not a valid facebook page url.", "error")
			}
			pageUrls.push(pageUrl)	
	} else { // CSV		
		let csvUrls = await utils.getDataFromCsv(spreadsheetUrl, columnName)
		csvUrls = csvUrls.filter(str => str) // removing empty lines
		for (let i = 0; i < csvUrls.length; i++) { // cleaning all group entries
			csvUrls[i] = utils.adjustUrl(csvUrls[i], "facebook")
		}
		csvUrls = csvUrls.filter(query => {
			if (agentObject.lastQuery && (query === agentObject.lastQuery)) {
				return true
			}
			for (const line of result) {
				if (query === line.query) {
					return false
				}
			}
			return true
		})
		pageUrls = csvUrls
	}

	return pageUrls
}

const scrapPageIdAndLikeNumbers = async (tab) => {
	let pageId
	let likeNumber
	try {
		await tab.waitUntilVisible("#entity_sidebar a[aria-label]", 10000)

		let profilePictureLink = await tab.evaluate((arg, cb) => {
			cb(null, document.querySelector("#entity_sidebar a[aria-label]").href)
		})
		const profilePictureUrl = new URL(profilePictureLink)
		pageId = profilePictureUrl.pathname.split("/")[1]

		await tab.waitUntilVisible("#pages_side_column", 10000)

		let likeText = await tab.evaluate((arg, cb) => {
			cb(null, document.querySelector("a[href*=friend_invi]").parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.children[2].firstChild.lastChild.firstChild.textContent)
		})
		likeNumber = parseInt(likeText.replace(/[^\d]/g, ""), 10)
	} catch (err) {
		utils.log(`Error accessing page!: ${err}`, "error")
		await buster.saveText(await tab.getContent(), `Error accessing page!${Date.now()}.html`)
		nick.exit(1)
	}			
	return { pageId, likeNumber}
}

const interceptRequestTemplate = async (result, agentObject, tab, pageUrl) => {
	let firstRequestUrl
	let urlTemplate
	let urlTemplateData
	let firstCursor = ""
	let firstPageNumber = 1

	const hasOnlyOnePage = await tab.isPresent("#browse_end_of_results_footer")

	if (!hasOnlyOnePage) {

		const onAjaxRequest = (e) => {
			let url = e.request.url
			if (!firstRequestUrl && url.includes("BrowseScrollingSetPagelet")) {
				firstRequestUrl = e.request.url
			}
		}

		tab.driver.client.on("Network.requestWillBeSent", onAjaxRequest)

		await tab.scrollToBottom()

		const initDate = new Date() 
		while (!firstRequestUrl) {
			await new Promise((resolve) => { 
				setTimeout(() => {
					resolve()
				}, 50)
			})
			if ((new Date() - initDate) > 10000) {
				break
			}
		}

		tab.driver.client.removeListener("Network.requestWillBeSent", onAjaxRequest)

		if (firstRequestUrl) {
			urlTemplate = new URL(firstRequestUrl)
			let urlTemplateDataJson = urlTemplate.searchParams.get("data")

			urlTemplateData = JSON.parse(urlTemplateDataJson)

			if (agentObject.lastQuery && (agentObject.lastQuery === pageUrl)
				&& (result.filter(query => query === pageUrl).length > 0)) {

				firstCursor = agentObject.resumeCursor
				firstPageNumber = agentObject.resumePageNumber
			}

			utils.log(`First request retreived using cursor ${firstCursor} and page number ${firstPageNumber}`, "info")
		}
	}

	return { urlTemplate, urlTemplateData, firstCursor, firstPageNumber }
}

const scrapUserData = (pageUrl, currentResult, responseResult, chr) => {
	responseResult.children().each((userIndex, divUser) =>{

		let profileLink = chr("a[data-testid]", divUser)

		let profileUrl = profileLink.attr("href")

		let name = profileLink.children("span").text()
		//utils.log(`Exporting ${name}...`, "loading")

		let imageUrl = chr("div > a > img", divUser).attr("src")
		let isFriend = (chr("div.FriendButton > a", divUser).length > 0)

		let userInfos = []
		chr("div > a", divUser).parent().each((infoIndex, infoElem) => {

			userInfos.push(chr(infoElem).text())
		})

		userInfos = userInfos.splice(userInfos.indexOf(name))

		let userInfo = {}
		userInfo.query = pageUrl
		userInfo.name = name
		userInfo.profileUrl = profileUrl
		userInfo.imageUrl = imageUrl
		userInfo.isFriend = isFriend
		userInfo.highlight = userInfos[1]
		for (let i = 2; i < userInfos.length; ++i) {

			userInfo["additionalData" + (i - 1)] = userInfos[i]
		}

		currentResult.push(userInfo)
	})

	return responseResult.children().length
}

const processResponseResult = async (tab, currentResult, pageUrl, urlTemplate, urlTemplateData, nextCursor, nextPageNumber) => {
	let chr
	let response
	let responseResult
	if (urlTemplate) {
		urlTemplateData["cursor"] = nextCursor
		urlTemplateData["page_number"] = nextPageNumber
		urlTemplate.searchParams.set("data", JSON.stringify(urlTemplateData))

		//utils.log(`Requesting ${urlTemplate.toString()}`, "info")

		let responseContent

		const onResponse = async (e) => {
			try {
				if (!responseContent && (e.type === "Document")) {
					let response = await tab.driver.client.Network.getResponseBody({requestId : e.requestId})
					responseContent = response.body
				}
			} catch (err) {
				// 
			}	
		}
				
		for (let retryNumber = 5; (!responseContent) && (retryNumber > 0); --retryNumber) {			
			tab.driver.client.on("Network.responseReceived", onResponse)

			await tab.open(urlTemplate.toString())

			const initDate = new Date() 
			while (!responseContent) {
				await new Promise((resolve) => { 
					setTimeout(() => {
						resolve()
					}, 50)
				})
				if ((new Date() - initDate) > 10000) {
					break
				}
			}

			tab.driver.client.removeListener("Network.responseReceived", onResponse)
		}

		let jsonPos = responseContent.indexOf("{")
		let jsonEndPos = responseContent.lastIndexOf("}")
		let responseJson = responseContent.substring(jsonPos, jsonEndPos + "}".length)
		response = JSON.parse(responseJson)

		let payload = response["payload"]

		chr = cheerio.load(payload)
		responseResult = chr("div[data-testid=\"results\"]")
	} else {
		let html = await tab.evaluate((arg, cb) => {
			cb(null, document.querySelector("div#initial_browse_result").innerHTML)
		})

		chr = cheerio.load(html)
		responseResult = chr("div#BrowseResultsContainer")
	}

	let likesScrapped = scrapUserData(pageUrl, currentResult, responseResult, chr)

	return { response, likesScrapped }
}

// Main function that execute all the steps to launch the scrape and handle errors
;(async () => {
	const tab = await nick.newTab()
	let { sessionCookieCUser, sessionCookieXs, spreadsheetUrl, columnName, csvName, maxLikers } = utils.validateArguments()
	if (!csvName) { csvName = "result" }

	let result = await utils.getDb(csvName + ".csv")

	let agentObject
	try {
		agentObject = await buster.getAgentObject()
	} catch (err) {
		utils.log("Could not access agent Object.", "warning")
	}

	let pageUrls = await retrieveAllPageUrls(result, agentObject, spreadsheetUrl, columnName)

	utils.log(`Cookie CUser: ${sessionCookieCUser}`, "info")
	utils.log(`Cookie Xs: ${sessionCookieXs}`, "info")
	await facebook.login(tab, sessionCookieCUser, sessionCookieXs)

	let currentResult = []
	let lastQuery
	let resumeCursor
	let resumePageNumber

	for (let pageUrl of pageUrls) {
		utils.log(`Page URL: ${pageUrl}`, "info")

		let pageLikesScrapped = (pageUrls.length === 1) ? 0 : result.filter(query => query === pageUrl).length
		
		try {
			await tab.open(pageUrl)
		} catch (err1) {
			try { // trying again
				await tab.open(pageUrl)
			} catch (err2) {
				utils.log(`Couldn't open ${pageUrl}`, "error")
				currentResult.push({query: pageUrl, error: "Could not open page"})
				continue
			}
		}

		let { pageId, likeNumber } = await scrapPageIdAndLikeNumbers(tab)

		// Main URL to scrap
		let urlToGo = `https://www.facebook.com/search/${pageId}/likers`

		try {
			await tab.open(urlToGo)
		} catch (err1) {
			try { // trying again
				await tab.open(urlToGo)
			} catch (err2) {
				utils.log(`Couldn't open ${urlToGo}`, "error")
				currentResult.push({query: pageUrl, error: "Could not open likers page"})
				continue
			}
		}

		utils.log(`Retrieving request template from ${urlToGo}...`, "loading")

		let { urlTemplate, urlTemplateData, firstCursor, firstPageNumber } = await interceptRequestTemplate(result, agentObject, tab, pageUrl)

		// Main loop to retrieve user infos
		let nextCursor = firstCursor
		let nextPageNumber = firstPageNumber
		let isEndOfPage = false
		while (!isEndOfPage && (!maxLikers || (pageLikesScrapped < maxLikers)))	{
			
			let {response, likesScrapped } = await processResponseResult(tab, currentResult, pageUrl, urlTemplate, urlTemplateData, nextCursor, nextPageNumber)
			pageLikesScrapped += likesScrapped

			if (urlTemplate) {
				let requests = response["jsmods"]["require"]
				for (let request of requests) {
					if (request.indexOf("BrowseScrollingPager") !== -1){
						for (let param of request) {
							let firstChild = param[0]
							if (_.isObject(firstChild) && (!_.isUndefined(firstChild.cursor))) {

								nextCursor = firstChild.cursor;
								break
							} else if (_.isNull(firstChild)) {
								isEndOfPage = true
								break
							}
						}
						break
					}
				}
				++nextPageNumber
			} else {
				isEndOfPage = true
			}

			if (likesScrapped > 0) {
				let progressLimit = ((maxLikers) ? Math.min(maxLikers, likeNumber) : likeNumber)
				utils.log(`Estimated progress: ${pageLikesScrapped} / ${progressLimit}`, "info")
				buster.progressHint(pageLikesScrapped / progressLimit, `${pageLikesScrapped} / ${progressLimit}`)
			}

			const timeLeft = await utils.checkTimeLeft()
			if (!timeLeft.timeLeft) {
				utils.log(`Scraping stopped: ${timeLeft.message}`, "warning")
				break
			}
		}

		lastQuery = pageUrl
		if (!isEndOfPage) {

			resumeCursor = nextCursor
			resumePageNumber = nextPageNumber
		}

	}

	result = result.concat(currentResult)

	await utils.saveResults(result, result, csvName)
	if (resumeCursor) { 
		await buster.setAgentObject({ lastQuery, resumeCursor, resumePageNumber })
	} else {
		await buster.setAgentObject({})
	}

    nick.exit(0)
})()
.catch(err => {
	utils.log(err, "error")
	nick.exit(1)
})
