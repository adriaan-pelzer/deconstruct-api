module.exports = ( severity, message ) => {
    if ( process.env.DEBUG && parseInt ( process.env.DEBUG ) >= severity ) {
        console.log ( message );
    }
};
