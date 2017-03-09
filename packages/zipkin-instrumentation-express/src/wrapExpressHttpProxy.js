const {Request, Annotation} = require('zipkin');
const url = require('url');

function formatRequestUrl(proxyReq) {
  // Protocol is not available in proxyReq by express-http-proxy
  const parsedPath = url.parse(proxyReq.path);
  return url.format({
    hostname: proxyReq.hostname,
    port: proxyReq.port,
    pathname: parsedPath.pathname,
    search: parsedPath.search,
    slashes: true // https://github.com/nodejs/node/issues/11103
  });
}

class ExpressHttpProxyInstrumentation {
  constructor({tracer, serviceName, remoteServiceName}) {
    this.tracer = tracer;
    this.serviceName = serviceName;
    this.remoteServiceName = remoteServiceName;
  }

  decorateAndRecordRequest(proxyReq, originalReq) {
    return this.tracer.scoped(() => {
      this.tracer.setId(this.tracer.createChildId());
      const traceId = this.tracer.id;

      // for use later when recording response
      const originalReqWithTrace = originalReq;
      originalReqWithTrace.traceId = traceId;

      const proxyReqWithZipkinHeaders = Request.addZipkinHeaders(proxyReq, traceId);
      this._recordRequest(proxyReqWithZipkinHeaders);
      return proxyReqWithZipkinHeaders;
    });
  }

  _recordRequest(proxyReq) {
    this.tracer.recordServiceName(this.serviceName);
    this.tracer.recordRpc(proxyReq.method.toUpperCase());
    this.tracer.recordBinary('http.url', formatRequestUrl(proxyReq));
    this.tracer.recordAnnotation(new Annotation.ClientSend());
    if (this.remoteServiceName) {
      this.tracer.recordAnnotation(new Annotation.ServerAddr({
        serviceName: this.remoteServiceName,
        port: proxyReq.port
      }));
    }
  }

  recordResponse(rsp, originalReq) {
    this.tracer.scoped(() => {
      this.tracer.setId(originalReq.traceId);
      this.tracer.recordBinary('http.status_code', rsp.statusCode.toString());
      this.tracer.recordAnnotation(new Annotation.ClientRecv());
    });
  }
}

function wrapProxy(proxy, {tracer, serviceName = 'unknown', remoteServiceName}) {
  return function zipkinProxy(host, options = {}) {
    const instrumentation = new ExpressHttpProxyInstrumentation({
      tracer,
      serviceName,
      remoteServiceName
    });
    const wrappedOptions = options;
    const wrappedDecorateRequest = wrappedOptions.decorateRequest;

    wrappedOptions.decorateRequest = (proxyReq, originalReq) => {
      const wrappedProxyReq = wrappedDecorateRequest(proxyReq, originalReq);
      return instrumentation.decorateAndRecordRequest(wrappedProxyReq, originalReq);
    };

    const wrappedIntercept = wrappedOptions.intercept;
    wrappedOptions.intercept = (rsp, data, originalReq, res, callback) => {
      const instrumentedCallback = (err, rspd, sent) => {
        instrumentation.recordResponse(rsp, originalReq);
        return callback(err, rspd, sent);
      };
      wrappedIntercept(rsp, data, originalReq, res, instrumentedCallback);
    };
    return proxy(host, wrappedOptions);
  };
}

module.exports = wrapProxy;