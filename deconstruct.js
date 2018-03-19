const H = require ( 'highland' );
const R = require ( 'ramda' );
const express = require ( 'express' ), app = express ();
const bodyParser = require ( 'body-parser' );
const fs = require ( 'fs' ), dirStream = H.wrapCallback ( R.bind ( fs.readdir, fs ) );
const path = require ( 'path' );
const crypto = require ( 'crypto' );
const jwt = require ( 'jsonwebtoken' );
const uuid = require ( 'uuid' );

const rDir = {
    path: null
};

const secrets = {};

const utils = {
    md5: string => {
        return crypto.createHash ( 'md5' ).update ( string ).digest ( 'hex' );
    },
    log: R.compose ( console.log, R.partialRight ( JSON.stringify, [ null, 4 ] ) ),
    streamRoute: H.wrapCallback ( ( routeName, utils, req, res, callback ) => {
        return require ( `${rDir.path}/${routeName}` )( R.assocPath ( [ 'callback' ], ( res, error, result ) => {
            if ( error === undefined && result === undefined ) {
                return callback;
            }

            return callback ( error, result );
        }, utils ), req, res );
    } ),
    auth: {
        options: {
            algorithm: 'HS256'
        },
        setIssuerSecret: ( issuerIid, secret ) => {
            secrets[issuerIid] = secret;
        },
        getIssuerSecret: issuerIid => secrets[issuerIid] || null,
        generateSecret: uuid.v4,
        generateKey: ( { issuerIid, expireInDays = 1, audience = 'users', payload }, callback ) => {
            const secret = getIssuerSecret ( issuerIid );

            if ( ! secret ) {
                return callback ( `No secret defined for issuer with iid ${issuerIid}` );
            }

            return H.wrapCallback ( R.bind ( jwt.sign, jwt ) )( payload, secret, {
                ...utils.auth.options,
                expiresIn: 30 * 24 * 60 * 60 * 1000,
                issuer: issuerIid,
                audience
            } )
                .toCallback ( callback );
        },
        verifyKey: ( { issuerIid, options, key }, callback ) => {
            return jwt.verify ( key, secret, {
                ...utils.auth.options,
                ...R.pick ( [ 'audience', 'issuer', 'ignoreExpiration' ], options )
            }, callback );
        }
    },
    error: ( res, error ) => {
        const localCallback = error => {
            return res.status ( error.code && parseInt ( error.code, 10 ) >= 200 ? parseInt ( error.code, 10 ) : 500 ).json ( error );
        };

        if ( error === undefined ) {
            return localCallback;
        }

        return localCallback ( error );
    },
    callback: ( res, error, result ) => {
        const localCallback = ( error, result ) => {
            if ( error ) {
                return utils.error ( res, error );
            }

            return res.json ( result );
        };

        if ( res === undefined ) {
            throw new Error ( 'utils.callback needs the response object as its first argument' );
        }

        if ( error === undefined && result === undefined ) {
            return localCallback;
        }

        return localCallback ( error, result );
    }
};

app.use ( bodyParser.json ( { limit: '50mb' } ) );

app.use ( ( req, res, next ) => {
    res.header ( 'Access-Control-Allow-Origin', '*' );
    res.header ( 'Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS, HEAD' );
    res.header ( 'Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Content-MD5' );
    next ();
} );

module.exports = {
    addUtil: ( name, util ) => {
        utils[name] = util;
    },
    loadRoutes: ( routeDir, callback ) => {
        rDir.path = path.resolve ( routeDir );

        return dirStream ( routeDir )
            .map ( R.sort ( ( a, b ) => {
                const getFirstDynamicComponent = route => {
                    return R.reduce ( ( memo, component ) => {
                        if ( memo.found ) {
                            return memo;
                        }

                        if ( component.match ( ':' ) ) {
                            return {
                                index: memo.index,
                                found: true
                            }
                        }

                        return {
                            index: memo.index + 1,
                            found: memo.found
                        };
                    }, { index: 0, found: false }, R.tail ( R.last ( route.split ( '/' ) ).split ( '~' ) ) );
                };

                return getFirstDynamicComponent ( b ).index - getFirstDynamicComponent ( a ).index;
            } ) )
            .sequence ()
            .filter ( route => R.reduce ( ( accept, re ) => {
                return accept && R.last ( route.split ( '/' ) ).match ( re );
            }, true, [
                /^~/,
                /\.js$/
            ] ) )
            .doto ( route => {
                const routeComponents = route.replace ( /\.js$/, '' ).split ( '~' );
                const pathSpec = R.init ( routeComponents ).join ( '/' );
                const method = R.last ( routeComponents );


                ( ( pathSpec, route, method ) => {
                    const routeHandler = require ( `${routeDir}/${route}` )( utils );

                    if ( method.toLowerCase () === 'get' ) {
                        console.log ( `registering ${pathSpec} HEAD` );

                        app.head ( pathSpec, ( req, res ) => {
                            return utils.streamRoute ( route, utils, req, res )
                                .toCallback ( ( error, response ) => {
                                    if ( error ) {
                                        return utils.error ( res, error );
                                    }

                                    return res.set ( 'X-Content-MD5', utils.md5 ( JSON.stringify ( response ) ) ).send ( '' );
                                } );
                        } );

                        console.log ( `registering ${pathSpec} GET` );

                        return app.get ( pathSpec, ( req, res ) => {
                            return utils.streamRoute ( route, utils, req, res )
                                .toCallback ( ( error, response ) => {
                                    if ( error ) {
                                        return utils.error ( res, error );
                                    }

                                    return res.set ( 'X-Content-MD5', utils.md5 ( JSON.stringify ( response ) ) ).json ( response );
                                } );
                        } );
                    }

                    console.log ( `registering ${pathSpec} ${method.toUpperCase ()}` );

                    return app[method] ( pathSpec, routeHandler );
                } )( pathSpec, route, method );
            } )
            .collect ()
            .toCallback ( callback );
    },
    start: port => {
        app.get ( '/healthcheck', ( req, res ) => res.json ( 200 ) );
        app.listen ( port );
    },
    getApp: () => {
        return app;
    }
};
