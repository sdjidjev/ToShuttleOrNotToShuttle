var ping = require('ping');

var hosts = ['4.2.2.1', 'google.com'];

hosts.forEach(function (host) {
    ping.promise.probe(host)
        .then(function (res) {
            console.log(res);
        });
});
