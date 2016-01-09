var co = require('co');
var path = require('path');
var url = require('url');
var swig = require('swig');
var request = require('request');
var redis = require('redis');
var wrapper = require('co-redis');
var serve = require('koa-static');
var koa = require('koa');
var app = koa();

var MS_IN_MINUTE = 60000;
var UPDATE_START_HOUR = 14;
var UPDATE_END_HOUR = 20;

var mapsApiKey;
if (process.env.MAPS_API_KEY) {
	mapsApiKey = process.env.MAPS_API_KEY;
} else {
	mapsApiKey = require('./config.json').mapsApiKey;
}

var locations = {
	work14: "1+Hacker+Way+Menlo+Park+CA",
	fremont: "2000+Bart+Way+Fremont+CA",
	oakland: "12th+St.+Oakland+City+Center+Oakland+CA",
	berkeley: "1945+Milvia+St+Berkeley+CA"
}

var routes = [
	{
		name: "Oakland",
		legs: [[locations.work14, locations.oakland, "driving"], [locations.oakland, locations.berkeley, "transit"]],
		times: [
			{
				hour: 16,
				minute: 20,
				name: "Shuttle 1",
				addTime: 0
			},
			{
				hour: 17,
				minute: 30,
				name: "Shuttle 2",
				addTime: 8
			},
			{
				hour: 18,
				minute: 12,
				name: "Shuttle 3",
				addTime: 8
			},
			{
				hour: 19,
				minute: 20,
				name: "Shuttle 4",
				addTime: 8
			}
		]
	},
	{
		name: "Fremont",
		legs: [[locations.work14, locations.fremont, "driving"], [locations.fremont, locations.berkeley, "transit"]],
		times: [
			{
				hour: 16,
				minute: 25,
				name: "Shuttle 1",
				addTime: 0
			},
			{
				hour: 17,
				minute: 25,
				name: "Shuttle 2",
				addTime: 0
			},
			{
				hour: 18,
				minute: 25,
				name: "Shuttle 3",
				addTime: 0
			},
			{
				hour: 19,
				minute: 05,
				name: "Shuttle 4",
				addTime: 0
			}
		]
	}
]

var baseApiUrl = "https://maps.googleapis.com/maps/api/distancematrix/json?";

// Set up Heroku Redis
var client;
if (process.env.REDIS_URL) {
  client = redis.createClient(process.env.REDIS_URL);
} else {
  client = redis.createClient();
}

var clientCo = wrapper(client);

function pad(n, width) {
  n = n + '';
  return n.length >= width ? n : new Array(width - n.length + 1).join('0') + n;
}

function setData(index, routeData) {
	client.llen("routeData", function(err, len) {
		if (len > index) {
			client.lset("routeData", index, JSON.stringify(routeData));
		}
	});
}

function updateDurations(route, offset, timezoneOffset) {
	route.times.forEach(function(time, index) {
		var d = new Date(Date.now() + timezoneOffset);
		d.setUTCHours(time.hour);
		d.setUTCMinutes(time.minute);
		d.setSeconds(0);
		d.setMilliseconds(0);
		if (d.getTime() - timezoneOffset < Date.now()) {
			d = new Date(d.getTime() + 24*60*60*1000);
		}
		var printTime = pad(d.getUTCHours(),2)+":"+pad(d.getUTCMinutes(),2)+" "+d.getUTCFullYear()+"/"+pad(d.getUTCMonth()+1, 2)+"/"+pad(d.getUTCDate(), 2);
		var rDate = new Date(d.getTime() - timezoneOffset + time.addTime*MS_IN_MINUTE)
		updateSingleDuration(offset+index, printTime, rDate, route, time, 0, 0, 0);
	});
}

function updateSingleDuration(index, printTime, rDate, route, time, leg, collectiveDuration, collectiveDiffDuration) {
	var rTime = Math.floor(rDate.getTime()/1000);
	request(
		baseApiUrl+"origins="+route.legs[leg][0]+"&destinations="+route.legs[leg][1]+"&mode="+route.legs[leg][2]+"&departure_time="+rTime+"&units=imperial&key="+mapsApiKey,
		function (error, response, body) {
		  if (!error && response.statusCode == 200) {
		  	var parsedBody = JSON.parse(body);
		  	if (parsedBody.status == "OK") {
		  		var duration = 0;
		  		var diffDuration = 0;
		  		if (parsedBody.rows[0].elements[0].duration_in_traffic == null) {
		  			duration = parsedBody.rows[0].elements[0].duration.value;
		  		} else {
		  			duration = parsedBody.rows[0].elements[0].duration_in_traffic.value;
		  			diffDuration = duration - parsedBody.rows[0].elements[0].duration.value;
		  		}
		  		if (leg == route.legs.length - 1) {
		  			var totalDuration = collectiveDuration + duration + time.addTime*60;
		  			var totalDiffDuration = collectiveDiffDuration + diffDuration;
		  			setData(index, [time.name, route.name, printTime, Math.round(totalDuration/60), Math.round(totalDiffDuration/60)]);
		  		} else {
		  			updateSingleDuration(index, printTime, new Date(rDate.getTime() + duration), route, time, leg+1, collectiveDuration + duration, collectiveDiffDuration + diffDuration);
		  		}
			} else {
				setData(index, [time.name, route.name, printTime, 0, 0]);
			}
		  }
		});
}

function updateAllDurations() {
	request(
		"https://maps.googleapis.com/maps/api/timezone/json?location=37,-122&timestamp="+Date.now()/1000+"&key="+mapsApiKey,
		function(error, response, body) {
			if (!error && response.statusCode == 200) {
				var parsedBody = JSON.parse(body);
			  	if (parsedBody.status == "OK") {
			  		var timezoneOffset = parsedBody.rawOffset * 1000;
					var date = new Date(Date.now() + timezoneOffset);
					if (date.getUTCHours() >= UPDATE_START_HOUR && date.getUTCHours() <= UPDATE_END_HOUR) {
						client.get("lastUpdateTime", function(err, lastUpdateTime) {
							var now = Date.now();
							if (lastUpdateTime == null || now - Number(lastUpdateTime) > 15*MS_IN_MINUTE) {
								var offset = 0;
								for (var i = 0; i < routes.length; i++) {
									updateDurations(routes[i], offset, timezoneOffset);
									offset += routes[i].times.length;
								}
								client.set("lastUpdateTime", now);
								console.log("updating...");
							}
						});
					}
				}
			}
		});
}

function startUpdateLoop() {
	setInterval(function() {
		updateAllDurations();
	}, 15*MS_IN_MINUTE);
	updateAllDurations();
}

var totalLength = 0;
for (var i = 0; i < routes.length; i++) {
	totalLength += routes[i].times.length;
}

co(function* () {
	var len = yield clientCo.llen("routeData");
	if (len != totalLength) {
		yield clientCo.del("lastUpdateTime");
		yield clientCo.del("routeData");
		for (var j = 0; j < totalLength; j++) {
			yield clientCo.rpush("routeData", "");
		}
		startUpdateLoop();
	}
});

var template = swig.compileFile(path.join(__dirname, '/views/index.html'));

app.use(serve(path.join(__dirname, '/static')));

app.use(function *(){
	var routes = yield clientCo.lrange("routeData", 0, -1);
	for (var i = 0; i < routes.length; i++) {
		try {
			var parsedJSON = JSON.parse(routes[i]);
			routes[i] = parsedJSON;
		} catch (e) {
			// do nothing
		}
	}
	var lastUpdateTime = yield clientCo.get("lastUpdateTime");
	this.body = template({
		routes: routes,
		minutesAgo: Math.round((Date.now() - lastUpdateTime)/1000/60)
	});
	
});

app.listen(process.env.PORT || 3000);