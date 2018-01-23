// Phantombuster configuration {
"phantombuster command: nodejs"
"phantombuster package: 4"
"phantombuster dependencies: lib-StoreUtilities.js"

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
	debug: false,
})

const StoreUtilities = require("./lib-StoreUtilities")
const utils = new StoreUtilities(nick, buster)
// }

const scrapeUserName = (arg, callback) => {
	callback(null, document.querySelector(".DashboardProfileCard-name").textContent.trim())
}

const twitterConnect = async (tab, sessionCookie) => {
	utils.log("Connecting to Twitter...", "loading")
	try {
		await nick.setCookie({
			name: "auth_token",
			value: sessionCookie,
			domain: ".twitter.com",
			httpOnly: true,
			secure: true
		})
		await tab.open("https://twitter.com/")
		await tab.waitUntilVisible(".DashboardProfileCard")
		utils.log(`Connected as ${await tab.evaluate(scrapeUserName)}`, "done")
	} catch (error) {
		utils.log("Could not connect to Twitter with this sessionCookie.", "error")
		nick.exit(1)
	}
}

const getFollowersNb = (arg, callback) => {
	callback(null, document.querySelectorAll(`div.GridTimeline div[data-test-selector="ProfileTimelineUser"]`).length)
}

const getDivsNb = (arg, callback) => {
	callback(null, document.querySelectorAll("div.GridTimeline-items > div.Grid").length)
}

const scrapeFollowers = (arg, callback) => {
	const followers = document.querySelectorAll(`div.Grid-cell[data-test-selector="ProfileTimelineUser"]`)

	const results = []

	for (const follower of followers) {
		const newFollower = {}
		if (follower.querySelector("div.ProfileCard > a")) {newFollower.profileUrl = follower.querySelector("div.ProfileCard > a").href}
		if (follower.querySelector("a.fullname")) {newFollower.name = follower.querySelector("a.fullname").textContent.trim()}
		if (follower.querySelector("p.ProfileCard-bio")) {newFollower.bio = follower.querySelector("p.ProfileCard-bio").textContent.trim()}
		results.push(newFollower)
	}
	callback(null, results)
}

const getTwitterFollowers = async (tab, twitterUrl) => {
	utils.log(`Getting your followers...`, "loading")
	await tab.open(twitterUrl)
	await tab.waitUntilVisible("div.GridTimeline")
	let loop = true
	let n = await tab.evaluate(getDivsNb)
	while (loop) {
		const timeLeft = await utils.checkTimeLeft()
		if (!timeLeft.timeLeft) {
			utils.log(`Stopped getting your followers: ${timeLeft.message}`, "warning")
			await utils.saveResult([])
			nick.exit()
		}
		await tab.scrollToBottom()
		try {
			await tab.waitUntilVisible(`div.GridTimeline-items > div.Grid:nth-child(${n+1})`)
			n = await tab.evaluate(getDivsNb)
			utils.log(`Loaded ${await tab.evaluate(getFollowersNb)} followers.`, "info")
		} catch (error) {
			utils.log(`Loaded ${await tab.evaluate(getFollowersNb)} followers.`, "done")
			loop = false
		}
	}
	const followers = await tab.evaluate(scrapeFollowers)
	utils.log(`Scraped all your followers`, "done")
	return followers
}

const unfollow = async (tab, twitterHandle) => {
	utils.log(`Unfollowing ${twitterHandle}...`, "loading")
	if (twitterHandle.match(/twitter\.com\/([A-z0-9\_]+)/)) {
		twitterHandle = twitterHandle.match(/twitter\.com\/([A-z0-9\_]+)/)[1]
	}
	await tab.open(`https://twitter.com/${twitterHandle}`)
	try {
		await tab.waitUntilVisible(".ProfileNav-item .following-text")
		await tab.click(".ProfileNav-item .following-text")
		try {
			await tab.waitUntilVisible(".ProfileNav-item .follow-text")
			utils.log(`${twitterHandle} unfollowed`, "done")
		} catch (error) {
			utils.log(`Clicked the unfollow button but could not verify if it was done for ${twitterHandle}`, "warning")
		}
	} catch (error) {
		utils.log(`You weren't following ${twitterHandle}`, "info")
	}
}

;(async () => {
	const tab = await nick.newTab()
	let {spreadsheetUrl, sessionCookie} = utils.validateArguments()
	await twitterConnect(tab, sessionCookie)
	let twitterProfiles = [spreadsheetUrl]
	if (spreadsheetUrl.indexOf("docs.google.com") > -1) {
		twitterProfiles = await utils.getDataFromCsv(spreadsheetUrl)
	}
	const followers = await getTwitterFollowers(tab, "https://twitter.com/followers")
	const peopleUnfollowed = []
	for (const url of twitterProfiles) {
		if (url) {
			const timeLeft = await utils.checkTimeLeft()
			if (!timeLeft.timeLeft) {
				utils.log(`Stopped unfollowing: ${timeLeft.message}`, "warning")
				break
			}
			if (followers.find(el => (el.profileUrl === url || el.profileUrl.indexOf(url) > -1 || url.indexOf(el.profileUrl) > -1))) {
				utils.log(`${url} is following you back`, "info")
			} else {
				try {
					await unfollow(tab, url)
					peopleUnfollowed.push({url: await tab.getUrl()})
				} catch (error) {
					utils.log(`Could not unfollow ${url}: ${error}`, "warning")
				}
			}
		}
	}
	await utils.saveResult(peopleUnfollowed)
	nick.exit()
})()
.catch(err => {
	utils.log(err, "error")
	nick.exit(1)
})
