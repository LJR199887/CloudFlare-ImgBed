// Docker URL imports run on the operator's network. Resolve once and connect
// to that exact public address; checking DNS before ordinary fetch would allow
// a second (rebound) lookup. This transport does not use the self-fetch rewrite.
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

const reserved = new BlockList();
for (const [address, prefix] of [
    ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
    ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
    ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],
]) reserved.addSubnet(address,prefix,'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::',3,'ipv6');
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) {
    reserved.addSubnet(address,prefix,'ipv6');
}
export function isPublicAddress(address) {
    switch (isIP(address)) {
        case 4: return !reserved.check(address,'ipv4');
        case 6: return globalV6.check(address,'ipv6') && !reserved.check(address,'ipv6');
        default: return false;
    }
}

export async function fetchPublicHop(url, resolve = lookup) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid download URL');
    const host = url.hostname.replace(/^\[|\]$/g,'');
    const addresses = isIP(host) ? [{address:host,family:isIP(host)}] : await resolve(host,{all:true});
    if (!addresses.length || !addresses.every(entry => isPublicAddress(entry.address))) throw new Error('Not a public download destination');
    const {address,family} = addresses[0];
    return new Promise((done,fail) => {
        const get = url.protocol === 'https:' ? https.get : http.get;
        const request = get(url, {
            agent:false, family, autoSelectFamily:false,
            lookup(_host, options, cb) {
                if (options.all) cb(null,[{address,family}]);
                else cb(null,address,family);
            },
            headers:{ 'Accept-Encoding':'identity' },
        }, res => {
            res.on('error', fail);
            // EventEmitter callbacks do not reject the enclosing Promise when
            // they throw. A hostile HTTP peer must not terminate the server.
            try {
                if (!Number.isInteger(res.statusCode) || res.statusCode < 200 || res.statusCode > 599) {
                    throw new Error('Invalid download response status');
                }
                const headers = new Headers();
                for (const key of ['content-type','content-length','content-range','content-encoding','content-disposition','etag','last-modified','location']) {
                    if (typeof res.headers[key] === 'string') headers.set(key,res.headers[key]);
                }
                const empty = [204,205,304].includes(res.statusCode);
                if (empty) res.resume();
                done(new Response(empty ? null : Readable.toWeb(res),{status:res.statusCode,headers}));
            } catch (error) {
                res.destroy();
                fail(error);
            }
        });
        request.on('error',fail);
        request.setTimeout(30000,() => request.destroy(new Error('Download timed out')));
    });
}
