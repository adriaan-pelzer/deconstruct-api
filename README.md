# deconstruct-api
A deconstructed, extendable API framework, minimising the amount of work to get things done

## installation & usage

In your project folder:
```
  npm install --save deconstruct-api
```

In your start script:
```js
  const dapi = require ( 'deconstruct-api' );
  
  dapi.loadRoutes ( path.resolve ( './my-routes' ), error => {
    if ( error ) {
      return console.error ( error );
    }
    
    dapi.start ( process.env.PORT );
  } );
```

### routes

#### handler names

The route folder is expected to contain routes handlers, the names of which are directly derived from the path it should serve, as follows:

GET /path/to/{some}/resource/{id} => ~path~to~:some~resource~:id~get.js

(where _some_ and _id_ are path parameters)

#### handler modules

All handler modules should be curried (a good library to use is [ramda.curry](http://ramdajs.com/docs/#curry)), and should accept three parameters:

```js
  const R = require ( 'ramda' );
  
  module.exports = R.curry ( ( utils, req, res ) => {} );
```

##### req

The request parameter is mostly accessed for query variables (_req.query_), path parameters (_req.params_), and in the case of POST and PUT, the body (_req.body_).

##### utils

Utils provides a few handy utilities:

###### log

A handy console.log replacement that stringifies JSON with line breaks and indentation.

###### callback

Returns results & errors to the user by simply calling them back. This utility is called with the _res_ parameter, and returns a callback function.

(See _error_ utility for HTTP status codes)

```js
  const R = require ( 'ramda' );
  
  module.exports = R.curry ( ( utils, req, res ) => {
    if ( ! is_auth ) {
        return utils.callback ( res )( {
            code: 401,
            message: 'Authentication required'
        } );
    }
    
    return utils.callback ( res )( {
        status: 'success'
    } );
  } );
```

###### error

Returns errors to the user by simply calling them back. This utility is called with the _res_ parameter, and returns a callback function that can be called on any error. (Equivalent to calling _utils.callback ( res )( error, null )_)

If the error is an object, and has a numerical _code_ attribute, the value of code is returned as the HTTP status code of the response.
Otherwise, a status code of 500 will be returned.

```js
  const R = require ( 'ramda' );
  
  module.exports = R.curry ( ( utils, req, res ) => {
    if ( ! is_auth ) {
        return utils.error ( res )( {
            code: 401,
            message: 'Authentication required'
        } );
    }
    
    return utils.callback ( res )( {
        status: 'success'
    } );
  } );
```

###### streamRoute

A utility to allow other routes to be re-used. It returns the result of route as a [highland](http://highlandjs.org/) stream. As first parameter, it expects the name of the route you whish to reuse, and the remaining three parameters are _utils_, _req_, and _res_:

```js
  const R = require ( 'ramda' );
  
  module.exports = R.curry ( ( utils, req, res ) => {
    utils.streamRoute ( '~some~:other~route~get.js', utils, req, res )
      .toCallback ( utils.callback ( res ) );
  } );
```

### addUtil

The addUtil method can be used to add your own, custom utilities to the _utils_ object that gets passed as the first argument to every handler. Only add utilities here that are completely ubiquitous (ie gets used by the majority of your handlers), or it will become bloated quite quickly.

### example

```js
   const H = require ( 'highland' );
   const R = require ( 'ramda' );
   const path = require ( 'path' );
   const cluster = require ( 'cluster' );
   const numCPUs = require ( 'os' ).cpus ().length;
   
   const deconstruct = require ( 'deconstruct-api' );
   
   const myUtil = someString => {
       return `transformed ${someString}`;
   };

   deconstruct.addUtil ( 'myUtil', myUtil ); // available as utils.myUtil ()

   if ( cluster.isMaster ) {
       console.log ( `MASTER: starting ${numCPUs} processes` );
       R.range ( 0, numCPUs ).forEach ( i => {
           console.log ( `MASTER: starting worker #${i}` );
           cluster.fork ();
       } );
   } else {
       return H.wrapCallback ( deconstruct.loadRoutes )( path.resolve ( './routes' ) )
           .errors ( error => {
               console.error ( error );
           } )
           .each ( routes => {
               console.log ( 'WORKER: started' );
               deconstruct.start ( process.env.PORT || 8080 );
           } );
   }
```
