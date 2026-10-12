"use strict";


/* =========================================================
   EXPERIMENT MARKER STORAGE ADAPTER
   IndexedDB primary storage
   localStorage compatibility / emergency mirror
   ========================================================= */

const DB_NAME =
    "ExperimentMarkerDB";


const DB_VERSION =
    1;


const CURRENT_CASE_STORE =
    "current_case";


const CASE_LIBRARY_STORE =
    "case_library";


const CURRENT_CASE_KEY =
    "current";


const LEGACY_STORAGE_KEY =
    "experiment-marker-mobile-prototype-v1";


/* =========================================================
   DATABASE
   ========================================================= */

function openExperimentMarkerDB() {

    return new Promise(
        (
            resolve,
            reject
        ) => {

            const request =
                indexedDB.open(
                    DB_NAME,
                    DB_VERSION
                );


            request.onupgradeneeded =
                event => {

                    const db =
                        event.target.result;


                    if (
                        !db.objectStoreNames.contains(
                            CURRENT_CASE_STORE
                        )
                    ) {

                        db.createObjectStore(
                            CURRENT_CASE_STORE,
                            {
                                keyPath:
                                    "storage_id",
                            }
                        );
                    }


                    if (
                        !db.objectStoreNames.contains(
                            CASE_LIBRARY_STORE
                        )
                    ) {

                        const library =
                            db.createObjectStore(
                                CASE_LIBRARY_STORE,
                                {
                                    keyPath:
                                        "library_id",
                                }
                            );


                        library.createIndex(
                            "case_id",
                            "case_id",
                            {
                                unique:
                                    false,
                            }
                        );


                        library.createIndex(
                            "saved_at_epoch_ms",
                            "saved_at_epoch_ms",
                            {
                                unique:
                                    false,
                            }
                        );
                    }
                };


            request.onsuccess =
                () => {

                    resolve(
                        request.result
                    );
                };


            request.onerror =
                () => {

                    reject(
                        request.error
                    );
                };
        }
    );
}


/* =========================================================
   CURRENT CASE
   ========================================================= */

async function idbGetCurrentCase() {

    const db =
        await openExperimentMarkerDB();


    return new Promise(
        (
            resolve,
            reject
        ) => {

            const transaction =
                db.transaction(
                    CURRENT_CASE_STORE,
                    "readonly"
                );


            const store =
                transaction.objectStore(
                    CURRENT_CASE_STORE
                );


            const request =
                store.get(
                    CURRENT_CASE_KEY
                );


            request.onsuccess =
                () => {

                    const record =
                        request.result;


                    resolve(
                        record
                            ?
                            record.case_data
                            :
                            null
                    );
                };


            request.onerror =
                () => {

                    reject(
                        request.error
                    );
                };


            transaction.oncomplete =
                () => {

                    db.close();
                };
        }
    );
}


async function idbPutCurrentCase(
    caseData
) {

    const db =
        await openExperimentMarkerDB();


    return new Promise(
        (
            resolve,
            reject
        ) => {

            const transaction =
                db.transaction(
                    CURRENT_CASE_STORE,
                    "readwrite"
                );


            const store =
                transaction.objectStore(
                    CURRENT_CASE_STORE
                );


            store.put(
                {
                    storage_id:
                        CURRENT_CASE_KEY,

                    case_data:
                        caseData,
                }
            );


            transaction.oncomplete =
                () => {

                    db.close();

                    resolve();
                };


            transaction.onerror =
                () => {

                    db.close();

                    reject(
                        transaction.error
                    );
                };
        }
    );
}


async function idbDeleteCurrentCase() {

    const db =
        await openExperimentMarkerDB();


    return new Promise(
        (
            resolve,
            reject
        ) => {

            const transaction =
                db.transaction(
                    CURRENT_CASE_STORE,
                    "readwrite"
                );


            transaction
                .objectStore(
                    CURRENT_CASE_STORE
                )
                .delete(
                    CURRENT_CASE_KEY
                );


            transaction.oncomplete =
                () => {

                    db.close();

                    resolve();
                };


            transaction.onerror =
                () => {

                    db.close();

                    reject(
                        transaction.error
                    );
                };
        }
    );
}


/* =========================================================
   LEGACY / MIRROR
   ========================================================= */

function readLocalStorageMirror() {

    const raw =
        localStorage.getItem(
            LEGACY_STORAGE_KEY
        );


    if (!raw) {
        return null;
    }


    try {

        return JSON.parse(
            raw
        );

    } catch (error) {

        console.error(
            "Unable to parse localStorage mirror:",
            error
        );


        return null;
    }
}


function writeLocalStorageMirror(
    caseData
) {

    localStorage.setItem(
        LEGACY_STORAGE_KEY,
        JSON.stringify(
            caseData
        )
    );
}


function deleteLocalStorageMirror() {

    localStorage.removeItem(
        LEGACY_STORAGE_KEY
    );
}


/* =========================================================
   RECONCILIATION
   ========================================================= */

function getSavedTimestamp(
    caseData
) {

    if (!caseData) {
        return 0;
    }


    const value =
        Number(
            caseData.saved_at_epoch_ms
            ||
            0
        );


    return Number.isFinite(
        value
    )
        ?
        value
        :
        0;
}


async function loadPersistentCase() {

    let indexedCase =
        null;


    try {

        indexedCase =
            await idbGetCurrentCase();

    } catch (error) {

        console.error(
            "IndexedDB read failed:",
            error
        );
    }


    const localCase =
        readLocalStorageMirror();


    /*
    If both exist, prefer whichever was saved later.

    This also protects against a sudden app termination
    occurring after the synchronous localStorage mirror
    was written but before an IndexedDB transaction finished.
    */

    let selected =
        null;


    if (
        indexedCase
        &&
        localCase
    ) {

        selected =
            getSavedTimestamp(
                localCase
            )
            >
            getSavedTimestamp(
                indexedCase
            )
                ?
                localCase
                :
                indexedCase;

    } else {

        selected =
            indexedCase
            ||
            localCase;
    }


    if (!selected) {
        return null;
    }


    /*
    Reconcile IndexedDB with the selected newest copy.
    */

    try {

        await idbPutCurrentCase(
            selected
        );

    } catch (error) {

        console.error(
            "IndexedDB migration/reconciliation failed:",
            error
        );
    }


    /*
    Keep the compatibility mirror aligned as well.
    */

    try {

        writeLocalStorageMirror(
            selected
        );

    } catch (error) {

        console.error(
            "localStorage mirror update failed:",
            error
        );
    }


    return selected;
}


/* =========================================================
   SAVE / DELETE
   ========================================================= */

let indexedDbWriteQueue =
    Promise.resolve();


function savePersistentCase(
    caseData
) {

    /*
    Create a stable snapshot before asynchronous work.
    */

    const snapshot =
        JSON.parse(
            JSON.stringify(
                caseData
            )
        );


    /*
    Synchronous emergency mirror.

    Timestamp capture has already happened before
    this function is called.
    */

    try {

        writeLocalStorageMirror(
            snapshot
        );

    } catch (error) {

        console.error(
            "localStorage mirror save failed:",
            error
        );
    }


    /*
    Serialize IndexedDB writes so rapid event taps
    cannot complete out of order.
    */

    indexedDbWriteQueue =
        indexedDbWriteQueue
            .then(
                () =>
                    idbPutCurrentCase(
                        snapshot
                    )
            )
            .catch(
                error => {

                    console.error(
                        "IndexedDB save failed:",
                        error
                    );
                }
            );


    return indexedDbWriteQueue;
}


async function deletePersistentCase() {

    deleteLocalStorageMirror();


    try {

        await indexedDbWriteQueue;

        await idbDeleteCurrentCase();

    } catch (error) {

        console.error(
            "Unable to delete IndexedDB current case:",
            error
        );
    }
}

/* =========================================================
   CASE LIBRARY
   ========================================================= */

function createLibraryId() {

    if (
        typeof crypto !== "undefined"
        &&
        typeof crypto.randomUUID === "function"
    ) {
        return crypto.randomUUID();
    }


    return (
        "case_"
        +
        Date.now()
        +
        "_"
        +
        Math.random()
            .toString(16)
            .slice(2)
    );
}


function cloneStorageData(
    value
) {

    return JSON.parse(
        JSON.stringify(
            value
        )
    );
}


async function idbPutLibraryRecord(
    record
) {

    const db =
        await openExperimentMarkerDB();


    return new Promise(
        (
            resolve,
            reject
        ) => {

            const transaction =
                db.transaction(
                    CASE_LIBRARY_STORE,
                    "readwrite"
                );


            transaction
                .objectStore(
                    CASE_LIBRARY_STORE
                )
                .put(
                    record
                );


            transaction.oncomplete =
                () => {

                    db.close();

                    resolve();
                };


            transaction.onerror =
                () => {

                    db.close();

                    reject(
                        transaction.error
                    );
                };
        }
    );
}


async function idbGetLibraryRecords() {

    const db =
        await openExperimentMarkerDB();


    return new Promise(
        (
            resolve,
            reject
        ) => {

            const transaction =
                db.transaction(
                    CASE_LIBRARY_STORE,
                    "readonly"
                );


            const request =
                transaction
                    .objectStore(
                        CASE_LIBRARY_STORE
                    )
                    .getAll();


            request.onsuccess =
                () => {

                    resolve(
                        request.result
                        ||
                        []
                    );
                };


            request.onerror =
                () => {

                    reject(
                        request.error
                    );
                };


            transaction.oncomplete =
                () => {

                    db.close();
                };
        }
    );
}


async function idbDeleteLibraryRecord(
    libraryId
) {

    const db =
        await openExperimentMarkerDB();


    return new Promise(
        (
            resolve,
            reject
        ) => {

            const transaction =
                db.transaction(
                    CASE_LIBRARY_STORE,
                    "readwrite"
                );


            transaction
                .objectStore(
                    CASE_LIBRARY_STORE
                )
                .delete(
                    libraryId
                );


            transaction.oncomplete =
                () => {

                    db.close();

                    resolve();
                };


            transaction.onerror =
                () => {

                    db.close();

                    reject(
                        transaction.error
                    );
                };
        }
    );
}


async function saveCaseToLibrary(
    caseData
) {

    const snapshot =
        cloneStorageData(
            caseData
        );


    const libraryId =
        snapshot.library_id
        ||
        createLibraryId();


    const savedAt =
        Date.now();


    snapshot.library_id =
        libraryId;


    snapshot.library_saved_at_epoch_ms =
        savedAt;


    const record = {

        library_id:
            libraryId,

        case_id:
            snapshot.case_id
            ||
            "",

        saved_at_epoch_ms:
            savedAt,

        case_data:
            snapshot,
    };


    await idbPutLibraryRecord(
        record
    );


    return cloneStorageData(
        snapshot
    );
}


async function listLibraryCases() {

    const records =
        await idbGetLibraryRecords();


    return records.sort(
        (
            a,
            b
        ) =>
            Number(
                b.saved_at_epoch_ms
                ||
                0
            )
            -
            Number(
                a.saved_at_epoch_ms
                ||
                0
            )
    );
}


async function deleteLibraryCase(
    libraryId
) {

    await idbDeleteLibraryRecord(
        libraryId
    );
}