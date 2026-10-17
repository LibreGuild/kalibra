"""Off means off: the SDK must cost nothing and do nothing when disabled."""

from __future__ import annotations

import asyncio
import os
import threading

from _fake import KEY, SdkTestCase

import kalibra
from kalibra import _core


def plain(x):
    return x + 1


async def aplain(x):
    return x + 1


class DisabledTest(SdkTestCase):
    def assert_no_sdk_threads(self) -> None:
        names = [t.name for t in threading.enumerate()]
        self.assertNotIn("kalibra-flush", names)

    def test_enabled_false_returns_the_functions_themselves(self) -> None:
        self.assertFalse(kalibra.init(enabled=False, url=self.fake.url, key=KEY))
        self.assertIs(kalibra.trace("t")(plain), plain)
        self.assertIs(kalibra.trace(plain), plain)
        self.assertIs(kalibra.step("s", kind="llm")(aplain), aplain)
        self.assertIs(kalibra.tool("search")(plain), plain)
        self.assertEqual(plain(1), 2)
        self.assert_no_sdk_threads()

    def test_kill_switch_wins_over_the_code(self) -> None:
        for value in ("false", "0", "OFF", "no"):
            with self.subTest(value=value):
                os.environ["KALIBRA_ENABLED"] = value
                self.assertFalse(kalibra.init(enabled=True, url=self.fake.url, key=KEY))
                self.assertIs(kalibra.trace("t")(plain), plain)
        # The kill switch also applies to decorators used before init().
        _core._reset_for_tests()
        os.environ["KALIBRA_ENABLED"] = "false"
        self.assertIs(kalibra.trace("t")(plain), plain)

    def test_env_flag_decides_without_enabled(self) -> None:
        # Same as the JS SDK: a value it doesn't recognise means off.
        for value, on in (("true", True), ("1", True), ("yes", True), ("maybe", False)):
            with self.subTest(value=value):
                os.environ["KALIBRA_ENABLED"] = value
                self.assertEqual(kalibra.init(url=self.fake.url, key=KEY), on)
                kalibra.shutdown()

    def test_no_key_means_off(self) -> None:
        self.assertFalse(kalibra.init(url=self.fake.url))
        self.assertIs(kalibra.trace("t")(plain), plain)

    def test_context_managers_are_shared_no_ops(self) -> None:
        kalibra.init(enabled=False)
        a, b = kalibra.trace("a"), kalibra.step("b")
        self.assertIs(a, b)  # one shared object: no allocation per call
        with kalibra.trace("t") as t:
            t.output = "ignored"
            t.metadata["user"] = "x"
            with kalibra.step("s", kind="retrieval") as s:
                s.output = [1, 2]
                s.set(model="m")
        self.assertIsNone(kalibra.current_trace().id)
        kalibra.current_trace().tags.append("x")  # writes go nowhere, no error
        self.assertTrue(kalibra.flush())
        self.assertEqual(self.fake.traces(), [])
        self.assert_no_sdk_threads()

    def test_async_context_managers_when_off(self) -> None:
        kalibra.init(enabled=False)

        async def main():
            async with kalibra.trace("t") as t:
                t.output = 1
            return await aplain(1)

        self.assertEqual(asyncio.run(main()), 2)

    def test_decorated_before_init_follows_init_later(self) -> None:
        # Decorators usually run at import time, before the app calls init().
        @kalibra.trace("early")
        def early(x):
            return x * 2

        self.assertTrue(hasattr(early, "__wrapped__"))  # not known yet whether the SDK is on
        kalibra.init(enabled=False)
        self.assertEqual(early(2), 4)
        self.assertTrue(kalibra.flush())
        self.assertEqual(self.fake.traces(), [])

        self.start()
        self.assertEqual(early(3), 6)
        traces = self.sent()
        self.assertEqual([t["name"] for t in traces], ["early"])

    def test_environment_alone_configures_the_sdk(self) -> None:
        os.environ.update({"KALIBRA_URL": self.fake.url, "KALIBRA_KEY": KEY, "KALIBRA_PROJECT": "Env project"})

        @kalibra.trace("from_env")
        def f():
            return 1

        f()  # first use initializes from the environment
        self.assertTrue(kalibra.is_enabled())
        self.assertEqual(len(self.sent()), 1)
        self.assertIn("/kalibra/api/projects/Env%20project/ingest/traces", self.fake.paths)
        self.assertEqual(self.fake.headers[-1]["Authorization"], f"Bearer {KEY}")

    def test_middlewares_and_tools_call_straight_through_when_off(self) -> None:
        kalibra.init(enabled=False)
        calls = []

        def wsgi_app(environ, start_response):
            calls.append(kalibra.from_headers({}).incoming.run_id)
            return [b"ok"]

        mw = kalibra.KalibraWSGIMiddleware(wsgi_app)
        self.assertEqual(mw({"HTTP_X_KALIBRA_RUN": "run_1"}, lambda *a: None), [b"ok"])

        async def asgi_app(scope, receive, send):
            calls.append(_core.incoming())

        asyncio.run(kalibra.KalibraASGIMiddleware(asgi_app)({"type": "http", "headers": [(b"x-kalibra-run", b"run_1")]}, None, None))
        self.assertEqual(calls, [None, None])
        self.assert_no_sdk_threads()
