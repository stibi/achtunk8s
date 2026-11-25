import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  const databaseUrl = "postgres://achtung:secret@db.example.com:5432/achtung";

  it("uses defaults for everything but the database", () => {
    expect(loadConfig({ DATABASE_URL: databaseUrl })).toEqual({
      host: "0.0.0.0",
      port: 8080,
      logLevel: "info",
      databaseUrl,
      alertmanagers: new Map(),
      irm: null,
      metrics: new Map(),
      handlerTokens: null,
    });
  });

  it("requires a Postgres database URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "mysql://db.example.com/achtung" })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("fails fast on invalid values", () => {
    expect(() => loadConfig({ DATABASE_URL: databaseUrl, PORT: "not-a-port" })).toThrow(/PORT/);
  });

  it("reads each instance's Alertmanager, with optional basic auth", () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      ALERTMANAGERS: JSON.stringify({
        onprem: { url: "http://alertmanager.monitoring.svc:9093", irmIntegrationId: "CABC123" },
        edge: { url: "https://alertmanager.example.com/", username: "achtung", password: "pw" },
      }),
    });

    expect(config.alertmanagers).toEqual(
      new Map([
        [
          "onprem",
          {
            url: "http://alertmanager.monitoring.svc:9093",
            basicAuth: null,
            irmIntegrationId: "CABC123",
          },
        ],
        [
          "edge",
          {
            url: "https://alertmanager.example.com/",
            basicAuth: { username: "achtung", password: "pw" },
            irmIntegrationId: null,
          },
        ],
      ]),
    );
  });

  it.each([
    ["not JSON", "{onprem"],
    ["an invalid instance name", JSON.stringify({ Onprem: { url: "http://am:9093" } })],
    ["a URL that is not HTTP", JSON.stringify({ onprem: { url: "ftp://am" } })],
    [
      "a username without a password",
      JSON.stringify({ onprem: { url: "http://am", username: "a" } }),
    ],
    ["an unknown field", JSON.stringify({ onprem: { url: "http://am", token: "t" } })],
    ["credentials in the URL", JSON.stringify({ onprem: { url: "http://a:s3cret@am:9093" } })],
    ["a URL that is not a URL", JSON.stringify({ onprem: { url: "not a url" } })],
    [
      "an IRM integration ID that is not one",
      JSON.stringify({ onprem: { url: "http://am", irmIntegrationId: "C1&perpage=100" } }),
    ],
    [
      "an empty IRM integration ID",
      JSON.stringify({ onprem: { url: "http://am", irmIntegrationId: "" } }),
    ],
  ])("rejects ALERTMANAGERS with %s", (_, value) => {
    expect(() => loadConfig({ DATABASE_URL: databaseUrl, ALERTMANAGERS: value })).toThrow(
      /ALERTMANAGERS/,
    );
  });

  it("never puts a password in its error", () => {
    const value = JSON.stringify({
      onprem: { url: "ftp://am", username: "a", password: "s3cret" },
    });
    expect(() => loadConfig({ DATABASE_URL: databaseUrl, ALERTMANAGERS: value })).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining("s3cret") }),
    );
  });

  const irmUrl = "https://oncall.example.com/oncall";

  it("reads Grafana IRM's API URL and token", () => {
    expect(
      loadConfig({ DATABASE_URL: databaseUrl, IRM_API_URL: irmUrl, IRM_API_TOKEN: "t0ken" }).irm,
    ).toEqual({ url: irmUrl, token: "t0ken" });
  });

  it.each([
    ["a URL without a token", { IRM_API_URL: irmUrl }, /IRM_API_TOKEN/],
    ["a token without a URL", { IRM_API_TOKEN: "t0ken" }, /IRM_API_TOKEN/],
    ["an empty token", { IRM_API_URL: irmUrl, IRM_API_TOKEN: "" }, /IRM_API_TOKEN/],
    ["a URL that is not HTTP", { IRM_API_URL: "ftp://oncall", IRM_API_TOKEN: "t" }, /IRM_API_URL/],
    [
      "credentials in the URL",
      { IRM_API_URL: "https://user:s3cret@oncall.example.com/oncall", IRM_API_TOKEN: "t" },
      /IRM_API_URL/,
    ],
  ])("rejects IRM with %s", (_, env, field) => {
    expect(() => loadConfig({ DATABASE_URL: databaseUrl, ...env })).toThrow(field);
  });

  it("never puts the IRM token or URL credentials in its error", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: databaseUrl,
        IRM_API_URL: "https://user:s3cret@oncall.example.com/oncall",
        IRM_API_TOKEN: "t0ken-s3cret",
      }),
    ).toThrow(expect.not.objectContaining({ message: expect.stringMatching(/s3cret/) }));
  });

  it("reads each instance's metrics backend, with optional auth, headers and matchers", () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      METRICS: JSON.stringify({
        "eu-prod": { url: "http://prometheus.monitoring.svc:9090" },
        edge: {
          url: "https://mimir.example.com/prometheus",
          bearerToken: "t0ken",
          headers: { "X-Scope-OrgID": "tenant-1" },
          matchers: { cluster: "edge" },
        },
        lab: { url: "https://metrics.example.com/", username: "achtung", password: "pw" },
      }),
    });

    expect(config.metrics).toEqual(
      new Map([
        [
          "eu-prod",
          { url: "http://prometheus.monitoring.svc:9090", auth: null, headers: {}, matchers: {} },
        ],
        [
          "edge",
          {
            url: "https://mimir.example.com/prometheus",
            auth: { kind: "bearer", token: "t0ken" },
            headers: { "X-Scope-OrgID": "tenant-1" },
            matchers: { cluster: "edge" },
          },
        ],
        [
          "lab",
          {
            url: "https://metrics.example.com/",
            auth: { kind: "basic", username: "achtung", password: "pw" },
            headers: {},
            matchers: {},
          },
        ],
      ]),
    );
  });

  it.each([
    ["not JSON", "{eu-prod"],
    ["an invalid instance name", { Onprem: { url: "http://p:9090" } }],
    ["a URL that is not HTTP", { "eu-prod": { url: "ftp://p" } }],
    ["credentials in the URL", { "eu-prod": { url: "http://a:s3cret@p:9090" } }],
    ["a password without a username", { "eu-prod": { url: "http://p", password: "pw" } }],
    [
      "basic auth and a bearer token",
      { "eu-prod": { url: "http://p", username: "a", password: "pw", bearerToken: "t" } },
    ],
    [
      "an Authorization header",
      { "eu-prod": { url: "http://p", headers: { Authorization: "t" } } },
    ],
    [
      "a header value over lines",
      { "eu-prod": { url: "http://p", headers: { "X-A": "a\r\nB: c" } } },
    ],
    [
      "a matcher that is not a label name",
      { "eu-prod": { url: "http://p", matchers: { "a-b": "c" } } },
    ],
    ["an unknown field", { "eu-prod": { url: "http://p", query: "up" } }],
  ])("rejects METRICS with %s", (_, value) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    expect(() => loadConfig({ DATABASE_URL: databaseUrl, METRICS: text })).toThrow(/METRICS/);
  });

  it("never puts a metrics backend's secrets in its error", () => {
    const value = JSON.stringify({
      "eu-prod": { url: "ftp://p", username: "a", password: "s3cret", bearerToken: "t0ken-s3cret" },
    });
    expect(() => loadConfig({ DATABASE_URL: databaseUrl, METRICS: value })).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining("s3cret") }),
    );
  });

  it("reads each handler's token", () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      HANDLER_TOKENS: JSON.stringify({
        "herdr-agent": "an-example-token-1",
        llm: "an-example-token-2",
      }),
    });

    expect(config.handlerTokens).toEqual(
      new Map([
        ["herdr-agent", "an-example-token-1"],
        ["llm", "an-example-token-2"],
      ]),
    );
  });

  it.each([
    ["text that isn't JSON", "herdr-agent=token"],
    ["a handler id that isn't one", JSON.stringify({ "Herdr Agent": "an-example-token-1" })],
    ["a token under 16 characters", JSON.stringify({ "herdr-agent": "sh0rt-s3cret" })],
    ["a token that isn't text", JSON.stringify({ "herdr-agent": 42 })],
    [
      "one token for two handlers",
      JSON.stringify({ "herdr-agent": "sh4red-s3cret-token", llm: "sh4red-s3cret-token" }),
    ],
  ])("rejects handler tokens with %s, without quoting a token", (_, value) => {
    const load = () => loadConfig({ DATABASE_URL: databaseUrl, HANDLER_TOKENS: value });

    expect(load).toThrow(/HANDLER_TOKENS/);
    expect(load).toThrow(expect.not.objectContaining({ message: expect.stringMatching(/s3cret/) }));
  });
});
