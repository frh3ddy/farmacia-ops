import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { assert } from "riteway/vitest";
import { servesIndexHtml } from "./spa-fallback";

/** The first path segment of every `@Controller('…')` in the api's source. */
const controllerPrefixes = () =>
  [
    ...new Set(
      readdirSync(__dirname, { recursive: true })
        .map(String)
        .filter((file) => file.endsWith(".controller.ts"))
        .flatMap((file) => [...readFileSync(join(__dirname, file), "utf8").matchAll(/@Controller\(['"]([^'"]+)['"]\)/g)])
        .map(([, route]) => route.split("/")[0]),
    ),
  ].sort();

describe("servesIndexHtml", () => {
  test("a page the web app routes", () => {
    assert({
      given: "a browser loading a web app page",
      should: "serve index.html",
      actual: servesIndexHtml("GET", "/ops/sueltos"),
      expected: true,
    });
  });

  test("api routes", () => {
    const served = controllerPrefixes().filter((prefix) => servesIndexHtml("GET", `/${prefix}/x`));
    assert({
      given: "a request under any controller's route",
      should: "leave it to the api, never serve the page",
      actual: served,
      expected: [],
    });
  });

  test("a call that isn't a page load", () => {
    assert({
      given: "a POST outside every api route",
      should: "leave it to the api, so it gets a 404 rather than a 200 page",
      actual: servesIndexHtml("POST", "/no-such-route"),
      expected: false,
    });
  });

  test("files and the root", () => {
    assert({
      given: "a file or the root path",
      should: "leave it to the static files",
      actual: [servesIndexHtml("GET", "/assets/app.js"), servesIndexHtml("GET", "/")],
      expected: [false, false],
    });
  });
});
