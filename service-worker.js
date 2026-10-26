"use strict";


const CACHE_NAME =
    "experiment-marker-general-v08-maryho";


const APP_SHELL = [
    "./",
    "./index.html",
    "./style.css",
    "./storage.js",
    "./app.js",
    "./manifest.json",
    "./icons/maryho-180.png",
    "./icons/maryho-192.png",
    "./icons/maryho-512.png"
];


/* =========================================================
   INSTALL
   Cache the application shell.
   ========================================================= */

self.addEventListener(
    "install",
    event => {

        event.waitUntil(
            caches
                .open(
                    CACHE_NAME
                )
                .then(
                    cache =>
                        cache.addAll(
                            APP_SHELL
                        )
                )
        );

        self.skipWaiting();
    }
);


/* =========================================================
   ACTIVATE
   Remove older application caches.
   ========================================================= */

self.addEventListener(
    "activate",
    event => {

        event.waitUntil(
            caches
                .keys()
                .then(
                    cacheNames =>
                        Promise.all(
                            cacheNames
                                .filter(
                                    name =>
                                        name !==
                                        CACHE_NAME
                                )
                                .map(
                                    name =>
                                        caches.delete(
                                            name
                                        )
                                )
                        )
                )
        );

        self.clients.claim();
    }
);


/* =========================================================
   FETCH
   Network first while online.
   Cache fallback while offline.

   This is convenient during development:
   new code is fetched normally when available,
   but the cached application can still run offline.
   ========================================================= */

self.addEventListener(
    "fetch",
    event => {

        const request =
            event.request;


        if (
            request.method !==
            "GET"
        ) {
            return;
        }


        const requestUrl =
            new URL(
                request.url
            );


        if (
            requestUrl.origin !==
            self.location.origin
        ) {
            return;
        }


        event.respondWith(
            fetch(
                request
            )
                .then(
                    response => {

                        if (
                            response
                            &&
                            response.ok
                        ) {

                            const copy =
                                response.clone();


                            caches
                                .open(
                                    CACHE_NAME
                                )
                                .then(
                                    cache =>
                                        cache.put(
                                            request,
                                            copy
                                        )
                                );
                        }


                        return response;
                    }
                )
                .catch(
                    async () => {

                        const cached =
                            await caches.match(
                                request
                            );


                        if (cached) {
                            return cached;
                        }


                        if (
                            request.mode ===
                            "navigate"
                        ) {

                            return caches.match(
                                "./index.html"
                            );
                        }


                        throw new Error(
                            "Resource unavailable offline."
                        );
                    }
                )
        );
    }
);