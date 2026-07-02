# Record a *real* page (bookmarklet)

The `recorder-demo.html` page records itself. To point the spike at a real site
(GitHub, docs, a blog) without building a browser extension, use this bookmarklet.

## Install

Create a new bookmark and paste this as the URL:

```
javascript:(function(){if(window.__rrspike)return;window.__rrspike=1;var R='http://localhost:7900';var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.4/dist/rrweb.min.js';s.onload=function(){var b=[];window.__rrstop=rrweb.record({emit:function(e){b.push(e);},checkoutEveryNms:5000,sampling:{mousemove:50,scroll:100,input:'last'}});setInterval(function(){if(!b.length)return;var p=JSON.stringify(b);b=[];fetch(R+'/emit',{method:'POST',headers:{'content-type':'application/json'},body:p}).catch(function(){});},250);console.log('[rrspike] recording -> '+R);};document.body.appendChild(s);})();
```

## Use

1. Start the relay: `node relay.mjs`
2. Open the target page, click the bookmark.
3. Open `http://localhost:7900/viewer` in another tab — the real page mirrors there.

## The catch: Content-Security-Policy

Many sites (GitHub, Twitter/X, banks) send a strict CSP that blocks both the
CDN `<script>` (`script-src`) and the `fetch` to `localhost` (`connect-src`).
On those, the bookmarklet silently does nothing — check the console for CSP errors.

Where it works today: permissive sites, most blogs/docs, `about:blank` with pasted
content, local `file://` pages, and anything with a lax CSP.

**This is exactly why the real design uses a browser *extension*, not a bookmarklet.**
An extension's content script runs in an isolated world that is not subject to the
page's CSP for its own script, and its `fetch`/native-messaging is extension-scoped.
The bookmarklet is only here to prove the record→stream→replay loop end-to-end
without any install step.
