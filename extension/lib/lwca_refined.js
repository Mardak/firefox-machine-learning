//LWCA refined
//2014-09-08 mruttley
//Refined version of LWCA algorithm/process

//Three stages:
// - Pre-processing
// - Classification
// - Post-processing

//How to use? Simply:
// > var lwca = new LWCAClassifier()
// > lwca.classify("http://www.bbc.com/some_very_interesting_article", "Apple reveals shiny new gadget")
// >>> ['computers', 0.75]

const {Cc, Ci, Cu, ChromeWorker} = require("chrome");
Cu.import("resource://gre/modules/Task.jsm");

var preprocessingProgressPercent = 0 //global variable to indicate how far in the pre processing the user is
var verbose = false

function LWCAClassifier(){
	// Main handler class
	
	//Initialize various processors
	if (verbose) console.log("Initializing...")
	
	let cdb = new ComponentDatabase() //objects that help match title components and query variables
	//it also checks if it needs to be updated etc
	
	let ce = new ClassificationEngine()
	
	//Handle requests
	this.classify = function(url, title){
		
		//pre process
			title = title.toLowerCase()
			
			if (verbose) console.log("Pre processing")
			//shortcuts
			let sd = spotDefinites(url, title)
			if (sd) {
				if (verbose) console.log("Spotted definite match")
				return sd
			}
		
			//cleaning
			if (verbose) console.log("title before cleaning: " + title)
			title = removePersistentTitleChunks(url, title, cdb.persistentTitleChunks)
			title = removeDomainNames(url, title) //try to remove domain names
			if (verbose) console.log("after: " + title)
		
		//classify
			if (verbose) console.log("Classifying")
			
			if (verbose) console.log("Payload size is: " + Object.keys(payload).length)
			if (verbose) console.log("DomainRules size is: " + Object.keys(domainRules).length)
			
			//cosine similarity
			let scores = ce.classify(url, title)
			
			if (verbose) console.log("scores: " + scores)
			
			if (scores.length == 0) {
				return "Sorry, currently uncategorizable"
			}
		
		//post process
			if (verbose) console.log("Post processing")
			
			if (verbose) console.log('looking for domain scores')
			let domain_scores = augmentDomainMatchers(url, title, scores)
			if (domain_scores != scores) {
				if (verbose) console.log('adjusted!')
				return domain_scores.sort(sortDescendingBySecondElement)[0]
			}
			
			//if that didn't change anything, last resort is using queries and repeats
			if (verbose) console.log("trying query augmentation")
			scores = augmentQueries(url, scores, cdb.queryVariables)
			if (verbose) console.log('scores: ' + scores)
			//console.log("trying repeat word augmentation")
			//scores = augmentRepeatWords(scores)
			//console.log('scores: ' + scores)
			
			//convert from Wiki to IAB v2
			scores = convertWikiToIAB(scores)
		
		//finish up
			if (verbose) console.log("Finishing up")
			return scores.sort(sortDescendingBySecondElement)[0]
		
	}

	this.init = function() {
		return Task.spawn(function*() {
			yield cdb.init();
		});
	};
}

// Pre-processors

function spotDefinites(url, title){
	//function to spot a definite classification
	//e.g. "real estate" is definitely real estate
	
	let definites = {
		"real estate": "real estate", //TODO: moarr
	}
	
	for (let definiteMatch in definites) {
		if (title.indexOf(definiteMatch) != -1) {
			return definites[definiteMatch]
		}
	}
	
	return false //false if nothing found
}

function ComponentDatabase(create_objects=true) {
	//creates a database of known query variables and persistent title components
	
	//initialization
	this.queryVariables = {}
	this.persistentTitleChunks = {}
	this.meta = {'timestamp':0}
	
	this.init = function() {return Task.spawn(function*() {
		if (verbose) console.log("Began the init function in Cdb")
		let ts = yield this.find_start_and_end();
		if (ts['start'] == 0) {
			//nothing ever made before
			if (verbose) console.log('Nothing found in local directory, so scanning the whole history')
			let cdb = this.scan(ts['start'], ts['end'])
			this.queryVariables = cdb['queryVariables']
			this.persistentTitleChunks = cdb['persistentTitleChunks']
		}else{
			//something made before, so load it
			if (verbose) console.log('Found cdb in local directory, importing')
			yield this.load_component_database();
			
			
			//fill in the rest
			let cdb = this.scan(ts['start'], ts['end'])
			//then merge the new stuff with the old stuff
			
			//first query variables
			for (let domain in cdb['queryVariables']) {
				if (this.queryVariables.hasOwnProperty(domain) == false) {
					this.queryVariables[domain] = {}
				}
				for (let v of cdb['queryVariables'][domain]) {
					if (this.queryVariables[domain].hasOwnProperty(v) == false) {
						this.queryVariables[domain][v] = 1
					}
				}
			}
			
			//then title components
			for (let domain in cdb['persistentTitleChunks']) {
				if (this.persistentTitleChunks.hasOwnProperty(domain) == false) {
					this.persistentTitleChunks[domain] = {}
				}
				for (let v of cdb['persistentTitleChunks'][domain]) {
					if (this.persistentTitleChunks[domain].hasOwnProperty(v) == false) {
						this.persistentTitleChunks[domain][v] = 1
					}
				}
			}
			if (verbose) console.log('loaded existing cdb from disc')
		}
		this.save() //now save everything
	}.bind(this));};
	
	this.find_start_and_end = function() {return Task.spawn(function*() {
		//where to start and end the scanning (if any)
		
		//mostly a copy of get_history
		let options = historyService.getNewQueryOptions(); //make a blank query
		let query = historyService.getNewQuery();
		let result = historyService.executeQuery(query, options);
		let cont = result.root;
		cont.containerOpen = true;
		latest_timestamp = cont.getChild(0).time //this is the last url that the user visited, which is the 'end'
		cont.containerOpen = false;
		
		
		lm = yield this.load_meta(); //find last url visited's id
		if (lm == false) {
			if (verbose) console.log('Could not find any meta information. Everything needs to be scanned. Please create a component database first')
			return {'start': 0, 'end': latest_timestamp}
		}else{
			if (verbose) console.log('Found meta information on disc (ts: ' + this.meta['timestamp'] + ")")
			return {'start': this.meta['timestamp'], 'end':latest_timestamp} //start and ending timestamps of whatever needs to be updated
		}
	}.bind(this));};
	
	this.scan = function(start, end){
		let history = getHistory()
		//try and do the two together
		//arrange visits by domain
		
		let qv = {} //query variables
		let ptc = {} //persistent title components
		let domain_titles = {}
		
		history_total = 0
		for (let visit of history){
			if ((visit[2]>=start) && (visit[2]<=end)) {
				url = visit[0]
				url = parseUri(url)
				let domain = url.host
				
				//scan components
				for (let var_name in url.queryKey) {
					if (spaceFinder.test(url.queryKey[var_name])) {
						//Note: the following spaghetti is why you use a decent language like python
						//with sets/defaultdicts
						if (qv.hasOwnProperty(domain) == false) {
							qv[domain] = {}
						}
						if (qv[domain].hasOwnProperty(var_name) == false) {
							qv[domain][var_name] = 0
						}
						qv[domain][var_name] += 1
					}
				}
				
				//sort title
				if (domain_titles.hasOwnProperty(domain)==false) {
					domain_titles[domain] = []
				}
				
				if (visit[1] != null) {
					domain_titles[domain].push(visit[1])
				}
				history_total += 1
			}
			if (visit[2] > this.meta['timestamp']) {
				this.meta['timestamp'] = visit[2] //timestamp is now last item loaded
			}
		}
		
		if (verbose) console.log("Total history items loaded: " + history_total)
		
		if (verbose) console.log("Finding common suffixes in " + Object.keys(domain_titles).length + " domains ")
		//what are the most common suffixes?
		
		//first some sort of stats
		total_domains = Object.keys(domain_titles).length
		count = 0
		increment = total_domains / 100 //TODO
		
		//now for processing
		for (let domain in domain_titles){
			let suffixes = {}
			let titles = domain_titles[domain]
			for (let x=0;x<titles.length;x++){
				for (let y=x+1;y<titles.length;y++){
					if (titles[x]!=titles[y]) {
						let lcns = longestCommonNgramSuffix(titles[x], titles[y])
						if (lcns!=false) {
							if (suffixes.hasOwnProperty(lcns) == false) {
								suffixes[lcns] = 0
							}
							suffixes[lcns] += 1
						}
					}
					
				}
			}
			//eliminate those that only appear once 
			let to_add = []
			for (let suffix in suffixes) {
				let count = suffixes[suffix]
				if (count > 1) {
					to_add.push(suffix)
				}
			}
			//to_add must be sorted in descending order of length
			//as largest matches should be eliminated first
			to_add = to_add.sort(sortDescendingByElementLength)
			ptc[domain] = to_add
		}
		
		//now remove anything empty
		to_delete = []
		for (let x in ptc) {if (ptc[x].length == 0) {to_delete.push(x)}}
		for (let x of to_delete){delete ptc[x]}
		
		//return
		if (verbose) console.log('Done!')
		return {'persistentTitleChunks':ptc, 'queryVariables':qv}
	}
	
	this.load_meta = function() {return Task.spawn(function*() {
		if (verbose) console.log("load_meta function called")
		//load meta
		let decoder = new TextDecoder();
		
		/////////DEBUGGING
		meta_location = OS.Path.join(OS.Constants.Path.profileDir, "meta.json")
		console.log("Meta should be stored at: " + meta_location)
		
		let meta_exists = yield OS.File.exists(meta_location);
		if (meta_exists) {
			console.log("Meta file exists");
		}
		else {
			console.log("Meta does not exist");
			return false;
		}
		///////////////////
		
		try {
			let array = yield OS.File.read(meta_location);
			if (verbose) console.log('onSuccess for meta loading called')
			let info = decoder.decode(array);
			let data = JSON.parse(info)
			if (verbose) console.log('meta data found was: ' + JSON.stringify(data))
			this.meta = data
			return true //loads meta information into an object with timestamp and id
		}
		catch(ex) {
			if (verbose) console.log("Meta was not found")
			return false //file doesn't exist
		}
	}.bind(this));};
	
	this.load_component_database = function() {return Task.spawn(function*() {
		//loads the component database if it exists, else returns false
		let decoder = new TextDecoder();
		try {
			let array = yield OS.File.read(OS.Path.join(OS.Constants.Path.profileDir,"cdb.json"));
			let info = decoder.decode(array);
			info = JSON.parse(info)
			this.queryVariables = info['queryVariables']
			this.persistentTitleChunks = info['persistentTitleChunks']
			return true
		}
		catch(ex) {
			return false //file doesn't exist
		}
	}.bind(this));};
	
	this.save = function() {return Task.spawn(function*() {
		//assumes that both cdb and meta have been created
		let encoder = new TextEncoder();
		let meta_enc = encoder.encode(JSON.stringify(this.meta));
		let cdb_enc = encoder.encode(JSON.stringify({'queryVariables':this.queryVariables, 'persistentTitleChunks':this.persistentTitleChunks}));
		//save meta
		yield OS.File.writeAtomic(OS.Path.join(OS.Constants.Path.profileDir, "meta.json"),meta_enc,{tmpPath: OS.Path.join(OS.Constants.Path.profileDir, "meta.json.tmp")});
		//save component database
		yield OS.File.writeAtomic(OS.Path.join(OS.Constants.Path.profileDir, "cdb.json"),cdb_enc,{tmpPath: OS.Path.join(OS.Constants.Path.profileDir, "cdb.json.tmp")});
	}.bind(this));};
}

function removePersistentTitleChunks(url, title, cdb){
	//Removes common title endings such as " - Google Search" using the component database
	
	domain = getDomain(url)
	if (cdb.hasOwnProperty(domain)) {
		for (let suffix in cdb[domain]) {
			if (title.endsWith(suffix)) {
				//chop suffix from end
				title = title.slice(0, visit[1].length-suffix-length)
				break
			}
		}
	}
	
	return title
}

function removeDomainNames(url, title) {
	//tries to remove the domain name (or aspects of it) from the title
	//if this reduces the title to nothing, then just leave them in
	url = parseUri(url)
	url = url.host.split(".")
	title = title.toLowerCase().match(wordFinder)
	
	new_title = []
	removed = []
	
	for (let token of title) {
		if (url.indexOf(token)==-1) {
			new_title.push(token)
		}
	}
	
	if (new_title.length == 0) {
		return title.join(" ") 
	}else{
		return new_title.join(" ")
	}	
}

// Classification

function cosineSimilarity(text, category_keywords, category_magnitude){
	//calculates the cosine similarity between the two arguments
	//expects text to be an array of strings
	//expects category_keywords to be an object of string: int
	//returns a float
	
	//create vector
	let vector = {} //object of word: [text count, category count]
	for (let word of text) {
		if (vector.hasOwnProperty(word)==false) {
			if (category_keywords.hasOwnProperty(word)==false) {
				vector[word] = [1, 0]
			}else{
				vector[word] = [1, category_keywords[word]]
			}	
		}else{
			vector[word][0] += 1
		}
	}
	
	//calculate dot product
	
	let dot_product = 0
	let text_vector_magnitude = 0
	
	for(let word in vector){
		dot_product += (vector[word][0] * vector[word][1])
		text_vector_magnitude += Math.pow(vector[word][0], 2)
	}
	
	let denominator = Math.sqrt(text_vector_magnitude) * category_magnitude
	
	if (denominator != 0) {
		return dot_product / denominator
	}
	
	return 0
}

function ClassificationEngine(){
	//a class that can classify a visit 
	
	//initializer
	
	let categories = []
	for(let k of Object.keys(payload)){
		if (Object.keys(payload[k]).length >= 25) { //pruning
			categories.push(k)
		}
	}
	
	//possible further pruning
	// - must contain a unique key
	
	//build inverse index and magnitudes
	this.id_to_article = {}
	this.inverse_index = {}
	this.magnitudes = {} //note that magnitudes are based on article ids, not category names
	
	for(let index=0;index<categories.length;index++){
		let category = categories[index]
		let keywords = payload[category]
		let magnitude = 0
		
		this.id_to_article[index] = category
		for(let k in keywords){
			if (this.inverse_index.hasOwnProperty(k)==false) {
				this.inverse_index[k] = [index]
			}else{
				this.inverse_index[k].push(index)
			}
			magnitude += Math.pow(keywords[k], 2)
		}
		
		magnitude = Math.sqrt(magnitude) 	//precalculate magnitude square roots
		this.magnitudes[index] = magnitude
	}
	
	//classifier
	this.classify = function(url, title){
		title = title.toLowerCase().match(wordFinder)
		let matches = []
		
		articles = {} // a set of articles worth looking at, auto-deduped
		
		for (let keyword of title) {
			if (this.inverse_index.hasOwnProperty(keyword)) {
				for (let article of this.inverse_index[keyword]) {
					articles[article] = true //effectively the set intersection
				}
			}
		}
		
		let scores = [] //classify against each category
		
		for (let article_number in articles) {
			let category = this.id_to_article[article_number]
			let words = payload[category]
			similarity = cosineSimilarity(title, words, this.magnitudes[article_number])
			if (similarity != 0) {
				scores.push([category, similarity])
			}
			
		}
		
		scores = scores.sort(sortDescendingBySecondElement)
		return scores.slice(0, 10)
	}
	
}

// Post processing

function augmentRepeatWords(results) {
	//Adds 1 to the score of any result containing a repeated word
	
	wordCounts = {}
	for (i=0;i<results.length;i++) {
		tokens = results[i][0].toLowerCase().match(wordFinder)
		for (let token of tokens) {
			if (wordCounts.hasOwnProperty(token)==false) {
				wordCounts[token] = 0
			}
			wordCounts[token] += 1
		}
	}
	
	//now go through again and find the repeats
	for (i=0;i<results.length;i++) {
		tokens = results[i][0].toLowerCase().match(wordFinder)
		for (let token of tokens) {
			if (wordCounts[token] > 1) { //must be a repeat
				results[i][1] += 1
			}
		}
	}
	
	return results
}

function augmentDomainMatchers(url, title, results) {
	// grab domain classifications and multiply those that have
	// matching word lemmas/stems

	//typically anything called society or reference is a bad classification
	ignore = {
		'society': true,
		'reference': true, 
		'uncategorized': true,
		'__news_counter': true,
		'marketing': true,
	}
	
	class_maps = {
		'history': ['histor'],
		'sports': ['sport', 'gam'],
		'computers': ['comput', 'tech', 'algorithm', 'model'],
		'science': ['theor', 'hypothes', 'species', 'scien'],
		'shopping': ['store', 'shop', 'brand', 'outlet', 'inc', 'ltd', 'compan'],
		'news': ['the ', 'daily', 'morning', 'times', 'new'],
		'health': ['diet', 'health'],
		'hobby': ['interest', 'coin', 'stamp', 'hobb'],
		'cuisine': ['cuisine', 'culinary', 'food', 'sauce', 'method', 'cook', 'technique', 'style'],
		'travel': ['city', 'travel', 'rout', 'hotel', 'town', 'countr', 'state', 'region'],
		'education': ['school', 'education', 'class', 'university', 'college', 'campus'],
		'family': ['parent', 'famil', 'child', 'matern', 'father', 'mother', 'pat', 'mat', 'sister', 'brother', 'pregnan'],
		'finance': ['bank', 'financ', 'institut', 'loan', 'rate', 'tax'],
		'business': ['compan', 'inc', 'ltd', 'business'],
		'video-games': ['gam', 'video', 'computer', 'system', 'console'],
		'fashion': ['brand', 'design', 'fashion'],
		'tv': ['telev', 'tv', 'show', 'series', 'episode', 'season', 'character', 'act', 'theme'],
		'movies': ['film', 'movie', 'direct', 'act', 'prod', 'cinem', 'studio', 'set'],
		'technology': ['tech', 'digit', 'elec'],
		'food': ['recipe', 'restaurant', 'bar', 'cuisine', 'food', 'sauce', 'cook', 'technique', 'style'],
		'women': ['wom', 'fem'],
		'government': ['gov', 'admin', 'dept', 'nationa', 'polic'],
		'discounts': ['coupon', 'discount'],
		'consumer-electronics': ['model', 'brand', 'series', 'inc'],
		'arts': ['artist', 'paint', 'direct'],
		'politics': ['gov', 'polit', 'polic', 'law', 'charter', 'treat', 'part', 'coalition', 'bill', 'usc', 'parl', 'tax', 'camp'],
		'music': ['music', 'band', 'album', 'single', 'side', 'release', 'song', 'sing', 'lyric', 'genre', 'style'],
		'banking': ['bank', 'financ', 'institut', 'account', 'credit', 'debit'],
		'drinks': ['drink', 'ingredient'],
		'religion': ['religi', 'church', 'temple', 'congregat'],
		'cars': ['car', 'model', 'engin', 'moto', 'auto'],
		'outdoors': ['range', 'rout'],
		'reading': ['read', 'book', 'novel', 'ser', 'auth'],
		'games': ['game', 'lotter'],
		'home': ['home', 'style'],
		'career': ['career', 'job', 'pro'],
		'weather': ['hurr', 'season'],
		'photography': ['style'],
		'entertainment': ['entertain'],
		'blogging': ['blog'],
		'reviews': ['review'],
		'image-sharing': ['imag', 'shar'],
		'relationship': ['relation'],
		'clothes': ['brand', 'cloth', 'design', 'fashion'],
		'shoes': ['shoe', 'foot'],
		'email': ['mail'],
		'law': ['law', 'bill', 'treat', 'armis', 'cease', 'peace', 'legal', 'camp'],
		'real-estate': ['real', 'estate', 'zone', 'house', 'apart'],
		'radio': ['radio', 'channel', 'station'],
		'men': ['male', 'man', 'masc', 'men'],
		'pets': ['spec', 'breed', 'type', 'animal', 'pet'],
		'maps': ['map', 'chart', 'cart', 'projec'],
		'writing': ['author', 'book', 'series', 'issue', 'style', 'writ'],
		'motorcycles': ['bike', 'motor'],
		'dance': ['danc'],
	}
	
	url = parseUri(url)
	title = title.toLowerCase()
	//have to basically iteratively check if bits of the url are in domainRules
	//e.g. http://something.search.domain.com should first search for everything,
	//then search.domain.com, then domain.com
	//no point in searching for just .com
	
	domain = url.host.split(".")
	for (let dot_count in domain){
		key = domain.slice(dot_count).join(".")
		if (domainRules.hasOwnProperty(key)) {
			//found an entry in domainRules
			
			//For example:
			//   "engadget.com" : {
			//		"topics robots" : "science",
			//		"imac" : "computers",
			//		"__ANY" : [
			//		   "technology",
			//		   "shopping",
			//		   "consumer-electronics"
			//		],
			//		"review" : "reviews",
			//		"tag nintendowiiu" : "video-games"
			//	 },
			
			category_matchers = domainRules[key]
			decision = false
			keys = Object.keys(category_matchers).sort()
			
			//iterate through all keys, __ANY comes last to see if one matches
			for (let k in Object.keys(category_matchers)) {
				if (k != "__ANY") {
					tokens = k.split(" ")
					match_count = 0
					
					for (let token of tokens) {
						if (title.indexOf(token)!=-1) {
							match_count += 1
						}
					}
					
					if (match_count == tokens.length) {
						decision = category_matchers[k]
						if (verbose) console.log("Exact token match found")
						break
					}
				}
			}
			
			//check if decision was made
			if (decision == false) {
				if (category_matchers.hasOwnProperty("__ANY")) { //if not, look at __ANY
					if (verbose) console.log("No exact title token match found, so going with __ANY, which is: " + category_matchers['__ANY'])
					decision = category_matchers['__ANY']
				}else{
					return results //if there's still nothing, just return the original results from the argument
				}
			}
			
			//now try and rerank results based on components
			if(typeof decision === "string"){ //decision could be 1 or more categories, make it consistent
				decision = [decision]
			}
			
			//now iterate through the decision categories and add 1 to each result
			//category that contains the stems
			
			for(let category of decision){
				if (class_maps.hasOwnProperty(category)) {
					for (i=0;i<results.length;i++) {
						for (let stem of class_maps[category]) {
							if (results[i][0].toLowerCase().indexOf(stem) != -1) {
								results[i][1] += 1
								break
							}
						}
					}
				}
			}
			break
		}
	}
	return results
}

function augmentQueries(url, results, queryDatabase) {
	//Tries to spot any search queries in the url
	//Doubles the score of anything that contains a search query word
	
	if (verbose) console.log("URL: " + url)
	
	queries = [] //a list of strings
	url = parseUri(url) //
	
	if (queryDatabase.hasOwnProperty(url.host)) { //if the domain is in the db
		if (verbose) console.log("Domain: " + url.host + " is in the database")
		if (verbose) console.log("There are " + Object.keys(url.queryKey).length + " keys in the url")
		for (let variable in url.queryKey) { //iterate through url get variables
			if (queryDatabase[url.host].hasOwnProperty(variable)) { //if in the db
				query = unescape(url.queryKey[variable]) //append to list
				queries.concat(query.match(wordFinder))
			}
		}
	}
	
	//now find any result that contains a query word
	if (queries.length > 0) {
		for(let result in results){
			if (verbose) console.log("Iterating through results")
			for (let word of queries) {
				if (results[result][0].indexOf(word) != -1) {
					results[result][1] *= 2 //double the score
				}
			}
		}
	}
	
	
	return results
}

function convertWikiToIAB(results, level="top") {
	//converts a set of wiki categories to IAB categories
	//options for level are:
	// - top, all
	
	new_results = []
	
	for (let r of results) {
		let cat = r[0].toLowerCase()
		if (new_mappings.hasOwnProperty(cat)) {
			new_results.push([new_mappings[cat], r[1]])
		}else{
			if (verbose) console.log("wiki category: <" + cat + "> was not found in new_mappings.json")
		}
	}
	
	let counts = {}
	if (level==='top') {
		//bring everything to the top level
		for (let result of results) { //get frequencies per top level
			let wiki_cat_name = result[0].toLowerCase()
			let iab_mapping = new_mappings[wiki_cat_name]
			if (verbose) console.log('checking wiki: ' + wiki_cat_name + ' which has IAB mapping: ' + iab_mapping)
			
			top_level = 0
			
			//could be top level
			if (tree.hasOwnProperty(iab_mapping)){
				top_level = iab_mapping
			}else{
				for (let tlcat in tree) {
					if (tree[tlcat].indexOf(iab_mapping) != -1) {
						top_level = tlcat
						break
					}
				}
			}
			
			if (top_level != 0) {
				if (counts.hasOwnProperty(top_level) == false) {
					counts[top_level] = 1
				}else{
					counts[top_level] += 1
				}
			}
		}
	}else{
		for (let result of results) { //return the best of all levels
			let wiki_cat_name = result[0].toLowerCase() //bit too much code repetition here
			let iab_mapping = new_mappings[wiki_cat_name]
			if (verbose) console.log('checking wiki: ' + wiki_cat_name + ' which has IAB mapping: ' + iab_mapping)
			if (iab_mapping != undefined) {
				if (counts.hasOwnProperty(iab_mapping)) {
					counts[iab_mapping] = 1
				}else{
					counts[iab_mapping] += 1
				}
			}
		}
	}
	
	if (verbose) console.log('counts: ' + JSON.stringify(counts))
	
	//get top 2
	counts_list = []
	for (let key in counts) {counts_list.push([key, counts[key]])} //convert to list
	counts_list.sort(sortDescendingBySecondElement)
	
	//messy error handling
	if (counts_list.length == 0) {
		return ['Sorry, currently uncategorizable']
	}
	
	//if the top two are the same, then return the category that is associated with
	//otherwise just return #1
	if (counts_list.length == 1) {
		return [counts_list[0][0]]
	}else{
		if (counts_list[0][0] === counts_list[1][0]) {
			//return the iab of #1
			return [new_mappings[results[0][0].toLowerCase()]]
		}else{
			//return the top one of those
			return [counts_list[0][0]]
		}
	}
}

// Auxiliary functions, matchers, options etc

const {data} = require("sdk/self"); //not quite sure why this is necessary
let {TextEncoder, TextDecoder, OS} = Cu.import("resource://gre/modules/osfile.jsm", {}); //for file IO
let historyService = Cc["@mozilla.org/browser/nav-history-service;1"].getService(Ci.nsINavHistoryService);
let scriptLoader = Cc["@mozilla.org/moz/jssubscript-loader;1"].getService(Ci.mozIJSSubScriptLoader);
scriptLoader.loadSubScript(data.url("domainRules.json")); 
scriptLoader.loadSubScript(data.url("payload.json")); //TODO: combine payload and mapping
scriptLoader.loadSubScript(data.url("new_mappings.json")); 
scriptLoader.loadSubScript(data.url("mozcat_heirarchy.json")); 

function getDomain(url) {
	//returns the (sub)domain of a url
	//subdomains are treated as different entities to top level urls
	if (url.indexOf("://") != -1) {
		url = url.split("://")[1]
		if (url.indexOf("/") != -1) {
			url = url.split("/")[0]
		}
		if (url.indexOf("?") != -1) {
			url = url.split("?")[0]
		}
	}else{
		return false
	}
	return url
}

function getHistory(){
	//Generator that yields the most recent history urls one by one
	//Returned in the form [url, title, timestamp]

	//make a blank query
	let options = historyService.getNewQueryOptions();
	let query = historyService.getNewQuery();
	let result = historyService.executeQuery(query, options);

	//open up the results
	let cont = result.root;
	cont.containerOpen = true;
	
	//yield whatever there is
	for(let i=0; i < cont.childCount; i++){
		let node = cont.getChild(i);
		yield [node.uri, node.title, node.time];
	}
	
	//close the results container
	cont.containerOpen = false;
}

function parseUri (str) {
	// parseUri 1.2.2
	// (c) Steven Levithan <stevenlevithan.com>
	// MIT License
	// http://blog.stevenlevithan.com/archives/parseuri
	var	o   = parseUri.options,
		m   = o.parser[o.strictMode ? "strict" : "loose"].exec(str),
		uri = {},
		i   = 14;

	while (i--) uri[o.key[i]] = m[i] || "";

	uri[o.q.name] = {};
	uri[o.key[12]].replace(o.q.parser, function ($0, $1, $2) {
		if ($1) uri[o.q.name][$1] = $2;
	});

	return uri;
};

parseUri.options = {
	strictMode: false,
	key: ["source","protocol","authority","userInfo","user","password","host","port","relative","path","directory","file","query","anchor"],
	q:   {
		name:   "queryKey",
		parser: /(?:^|&)([^&=]*)=?([^&]*)/g
	},
	parser: {
		strict: /^(?:([^:\/?#]+):)?(?:\/\/((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?))?((((?:[^?#\/]*\/)*)([^?#]*))(?:\?([^#]*))?(?:#(.*))?)/,
		loose:  /^(?:(?![^:@]+:[^:@\/]*@)([^:\/?#.]+):)?(?:\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/
	}
};

function longestCommonNgramSuffix(s1, s2){
	//Does what it says on the tin
	s1 = s1.split(" ")
	s2 = s2.split(" ")
	min_len = s1.length < s2.length ? s1.length : s2.length
	
	result = false
	for (let a=1;a<min_len+1;a++){
		if (s1[s1.length-a] != s2[s2.length-a]) {
			result = s1.slice(s1.length-a+1)
			break
		}
	}
	
	if (result==false) {
		return false
	}else if (result==[]) {
		return false
	}else{
		return result.join(" ")
	}
}

String.prototype.endsWith = function(suffix) {
	//http://stackoverflow.com/a/2548133/849354
    return this.indexOf(suffix, this.length - suffix.length) !== -1;
};

var wordFinder = RegExp("[a-z]{3,}", "g") //tokenizes english sentences
var spaceFinder = RegExp(/.+(%20|\+|\s).+/g) //finds get variable values that have spaces in them
//bizarrely, if spaceFinder is declared in the way wordFinder is (two args), it returns an error. Oh JS...

function sortDescendingBySecondElement(first, second) {
	//function to be used in sort(some_function)
	//does what it says on the tin
	first = first[1]
	second = second[1]
	if (first == second) {
		return 0
	}else{
		if (first > second) {
			return false
		}else{
			return true
		}
	}	
}

function sortDescendingByElementLength(first, second) {
	//sorting function to sort a list of strings
	return second.length - first.length
}

//Classification persistence on disc

function saveClassifications(visit_id_to_iab_lower){
	//creates an id-iab mapping for brevity
	//saves that, and a mapping of visit id to classification id
	
	//create tree mapping using mozcat heirarchy
	iab_ids = {}
	count = 0
	for (let top_level in tree) {
		iab_ids[top_level] = count
		count += 1
		for(let subcat in tree[top_level]){
			iab_ids[subcat] = count
			count += 1
		}
	}
	
	//map classifications
	classifications = {}
	for (let visit_id in visit_id_to_iab_lower) {
		iab = visit_id_to_iab_lower[visit_id]
		mapping = iab_ids[iab]
		classifications[visit_id] = mapping
	}
	
	//now put everything together
	
	everything = {
		'mapping': iab_ids,
		'classifications': classifications
	}
	
	//now save
	
	let encoder = new TextEncoder();
	let array = encoder.encode(everything);
	let promise = OS.File.writeAtomic(OS.Path.join(OS.Constants.Path.profileDir, "classifications.json"), array, {tmpPath: OS.Path.join(OS.Constants.Path.profileDir, "classifications.json.tmp")});
	
}

function loadClassifications(){
	//returns an id to iab mapping
		//loads meta information into an object with timestamp and id
	let decoder = new TextDecoder();
	let promise = OS.File.read(OS.Path.join(OS.Constants.Path.profileDir, "meta.json"));
	promise = promise.then(
	  function onSuccess(array) {
		let info = decoder.decode(array);
		info = JSON.parse(info)
		
		//now expand it
		//create an id-to-text version of the mapping
		id_to_text = {}
		for (let iab in info['mapping']) {
			id = info['mapping'][iab]
			id_to_text[id] = iab
		}
		
		//need id to text version of iab
		for (let visitid in info['classifications']) {
			mapping_id = info['classifications'][visitid]
			info['classifications'][visitid] = id_to_text[mapping_id]
		}
		
		return info['classifications']
		
	  },
	  function onFailure(){
		return false //file doesn't exist
	  }
	);
	
}

//for the extension main.js to access
exports.LWCAClassifier = LWCAClassifier 