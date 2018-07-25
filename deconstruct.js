const H = require ( 'highland' );
const R = require ( 'ramda' );
const express = require ( 'express' ), app = express ();
const bodyParser = require ( 'body-parser' );
const fs = require ( 'fs' ), dirStream = H.wrapCallback ( R.bind ( fs.readdir, fs ) );
const path = require ( 'path' );
const crypto = require ( 'crypto' );
const jwt = require ( 'jsonwebtoken' );
const uuid = require ( 'uuid' );

const log = require ( 'lib/log.js' );

const rDir = {
    path: null
};

const utils = {
    sha256: string => {
        return crypto.createHash ( 'sha256' ).update ( string ).digest ( 'hex' );
    },
    md5: string => {
        return crypto.createHash ( 'md5' ).update ( string ).digest ( 'hex' );
    },
    log: R.compose ( console.log, R.partialRight ( JSON.stringify, [ null, 4 ] ) ),
    streamRoute: H.wrapCallback ( ( routeName, utils, req, res, callback ) => {
        if ( R.type ( res ) === 'Function' && typeof callback === 'undefined' ) {
            return res ( { code: 500, message: `res is undefined in streamRoute call on route ${routeName}` } );
        }

        return require ( `${rDir.path}/${routeName}` )( R.assocPath ( [ 'callback' ], ( res, error, result ) => {
            if ( error === undefined && result === undefined ) {
                return callback;
            }

            return callback ( error, result );
        }, utils ), req, res );
    } ),
    streamPrivateRoute: ( issuer, routeName, utils, req, res ) => {
        const timestamp = new Date ().valueOf ().toString ();

        return H.wrapCallback ( utils.auth.getIssuerSecret )( issuer )
            .errors ( ( error, push ) => {
                return push ( null, null );
            } )
            .flatMap ( secret => utils.streamRoute ( routeName, utils, {
                ...req,
                issuer,
                headers: secret ? {
                    ...req.headers,
                    Authorization: undefined,
                    authorization: [ 'Sig', utils.sha256 ( [ secret, timestamp ].join ( '' ) ), timestamp ].join ( ' ' )
                } : req.headers
            }, res ) );
    },
    treatResourceAsPrivate: req => H.wrapCallback ( utils.auth.verifyKey )( {
        options: { private: true, issuer: 'root' },
        authParms: utils.auth.getKey ( req )
    } ),
    jsonHeader: req => ( { ...req.headers, 'Content-Type': 'application/json' } ),
    bearerAuthHeader: ( req, key ) => ( { ...req.headers, authorization: [ 'Bearer', key ].join ( ' ' ), Authorization: undefined } ),
    sigAuthHeader: ( req, sig, timestamp ) => ( { ...req.headers, authorization: [ 'Sig', sig, timestamp ].join ( ' ' ), Authorization: undefined } ),
    auth: {
        options: {
            algorithm: 'HS256'
        },
        generateAuthCode: digits => {
            return R.reduce ( ( authCode, i ) => {
                return authCode + ( Math.floor ( Math.random () * 10 ) ).toString ();
            }, '', R.range ( 0, digits ) );
        },
        generateSecret: uuid.v4,
        generateKeyWithSecret: ( { secret, expiresInDays = 1, audience = 'users', payload, issuer }, callback ) => {
            return H.wrapCallback ( R.bind ( jwt.sign, jwt ) )( payload, secret, {
                ...utils.auth.options,
                expiresIn: expiresInDays * 24 * 60 * 60 * 1000,
                issuer,
                audience
            } )
                .toCallback ( callback );
        },
        generateKey: ( { expiresInDays = 1, audience = 'users', payload, issuer }, callback ) => {
            return H.wrapCallback ( utils.auth.getIssuerSecret )( issuer )
                .flatMap ( secret => H.wrapCallback ( utils.auth.generateKeyWithSecret )( { secret, expiresInDays, audience, payload, issuer } ) )
                .toCallback ( callback );
        },
        getKey: ( { headers: { Authorization, authorization }, bypassAuth } ) => {
            const authHeader = Authorization || authorization;

            if ( ! authHeader && ! bypassAuth ) {
                return null;
            }

            if ( authHeader ) {
                const [ authType, key, timestamp ] = authHeader.split ( ' ' );
                return { authType, key, timestamp, bypassAuth };
            }

            return { bypassAuth };
        },
        verifyKey: ( { options, authParms }, callback ) => {
            if ( ! authParms ) {
                if ( process.env.BYPASS_AUTH ) {
                    return callback ( null, { bypassed: true } );
                }

                return callback ( { code: 401, message: 'Authentication failed' } );
            }

            if ( authParms.authType === 'Bypass' && authParms.key === 'this' && authParms.timestamp === 'shit' ) {
                return callback ( null, { bypassed: true } );
            }

            return H.wrapCallback ( utils.auth.getIssuerSecret )( options.issuer )
                .flatMap ( H.wrapCallback ( ( secret, callback ) => {
                    if ( ! authParms || ! authParms.key || ! authParms.authType ) {
                        return callback ( { code: 401, message: `No authParms sent` } );
                    }

                    if ( authParms.authType === 'Sig' ) {
                        if ( ! authParms.timestamp ) {
                            return callback ( { code: 401, message: `No timestamp` } );
                        }

                        if ( authParms.timestamp < ( new Date ().valueOf () - 60000 ) ) {
                            return callback ( { code: 401, message: `Timestamp has expired` } );
                        }

                        if ( utils.sha256 ( [ secret, authParms.timestamp.toString () ].join ( '' ) ) !== authParms.key ) {
                            return callback ( { code: 401, message: `Signature verification failed` } );
                        }

                        return callback ( null, { name: options.issuer } );
                    }

                    if ( options.private ) {
                        return callback ( { code: 401, message: `Only auth type Sig supported on this endpoint` } );
                    }

                    if ( authParms.authType !== 'Bearer' ) {
                        return callback ( { code: 401, message: `Auth type ${authParms.authType} not supported` } );
                    }

                    return jwt.verify ( authParms.key, secret, {
                        ...utils.auth.options,
                        ...R.pick ( [ 'issuer', 'audience', 'ignoreExpiration' ], options )
                    }, ( error, payload ) => {
                        if ( error ) {
                            return callback ( { code: 401, message: error.message || 'Not authorized' } );
                        }

                        return callback ( null, payload );
                    } );
                } ) )
                .toCallback ( callback );
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
    res.header ( 'Access-Control-Allow-Headers', 'Authorization, Origin, X-Requested-With, Content-Type, Accept, X-Content-MD5' );
    next ();
} );

module.exports = {
    setSecretRetriever: secretRetriever => utils.auth.getIssuerSecret = secretRetriever,
    addUtil: ( name, util ) => { utils[name] = util; },
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
            .collect ()
            .map ( routes => R.reduce ( ( reduced, route ) => {
                const method = R.last ( route.split ( '~' ) ).replace ( '.js', '' );
                const corrRoute = postfix => R.compose ( R.join ( '~' ), R.flip ( R.concat )( [ postfix ] ), R.init, R.split ( '~' ) );
                const corrOptionsRoute = corrRoute ( 'options.js' );
                const corrPreFlightRoute = corrRoute ( 'preflight' );
                const preFlightRoute = R.find ( rRoute => rRoute.indexOf ( corrPreFlightRoute ( route ) ) === 0, reduced );

                if ( R.contains ( corrOptionsRoute ( route ), routes ) ) {
                    return R.concat ( reduced, [ route ] );
                }

                if ( preFlightRoute ) {
                    return R.concat ( R.reject ( route => route === preFlightRoute, reduced ), [ route, `${preFlightRoute}-${method}` ] );
                }

                return R.concat ( reduced, [ route, `${corrPreFlightRoute ( route )}-${method}` ] );
            }, [], routes ) )
            .sequence ()
            .doto ( route => {
                const routeComponents = route.replace ( /\.js$/, '' ).split ( '~' );
                const pathSpec = R.init ( routeComponents ).join ( '/' );
                const method = R.last ( routeComponents );

                ( ( pathSpec, route, method ) => {
                    if ( method.match ( 'preflight' ) ) {
                        const methods = R.concat ( R.tail ( method.split ( '-' ) ), method.match ( 'get' ) ? [ 'head' ] : [] );
                        const methodHeader = R.map ( method => method.toUpperCase (), methods ).join ( ', ' );

                        console.log ( `registering ${pathSpec} OPTIONS (preflight ${methodHeader})` );

                        return app.options ( pathSpec, ( req, res ) => {
                            log ( 1, `OPTIONS ${pathSpec}` );
                            return res.set ( 'Access-Control-Allow-Methods', methodHeader ).send ( '' );
                        } );
                    }

                    const routeHandler = require ( `${routeDir}/${route}` )( utils );

                    if ( method.toLowerCase () === 'get' ) {
                        console.log ( `registering ${pathSpec} HEAD` );

                        app.head ( pathSpec, ( req, res ) => {
                            log ( 1, `HEAD ${pathSpec}` );
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
                            log ( 1, `GET ${pathSpec}` );
                            return utils.streamRoute ( route, utils, req, res )
                                .toCallback ( ( error, response ) => {
                                    if ( error ) {
                                        return utils.error ( res, error );
                                    }

                                    res.set ( 'X-Content-MD5', utils.md5 ( JSON.stringify ( response ) ) );

                                    return utils.callback ( res, error, response );
                                } );
                        } );
                    }

                    console.log ( `registering ${pathSpec} ${method.toUpperCase ()}` );

                    return app[method] ( pathSpec, ( req, res ) => {
                        log ( 1, `${method.toUpperCase()} ${pathSpec}` );
                        return routeHandler ( req, res );
                    } );
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
