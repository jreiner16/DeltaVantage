"""
Nasdaq Technology News Sentiment Strategy

Uses RSS technology/news feeds to calculate a sentiment score for the current symbol, then combines keywords in the news to calculate buy/sell signals.
NOT suitable for anything besides LIVE EXECUTION -- the news only looks at the current state, not point-in-time.
"""

import re
import time
import math
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from backend.strategy.base import Strategy, Bar
from backend.indicators.technical import sma


class NasdaqTechNewsSentiment(Strategy):

    # ------------------------------------------------------------------
    # Trading configuration
    # ------------------------------------------------------------------

    fast_period = 10
    slow_period = 50

    # Number of shares/contracts to trade
    order_qty = 10

    # News configuration
    news_lookback_hours = 24
    max_articles_per_feed = 50

    # How often to refresh RSS feeds.
    # Don't download RSS on every market bar.
    news_refresh_seconds = 300  # 5 minutes

    # Sentiment thresholds
    buy_sentiment_threshold = 0.20
    sell_sentiment_threshold = -0.20

    # Stronger threshold for actual trades.
    # This reduces over-trading from weak headlines.
    strong_buy_threshold = 0.35
    strong_sell_threshold = -0.35

    # Price confirmation requirement
    require_price_confirmation = True

    # ------------------------------------------------------------------
    # RSS feeds
    # ------------------------------------------------------------------

    RSS_FEEDS = [
        (
            "Technology",
            "https://news.google.com/rss/search?q="
            "technology+stocks+NASDAQ+AI+semiconductors&hl=en-US&gl=US&ceid=US:en"
        ),

        (
            "Semiconductors",
            "https://news.google.com/rss/search?q="
            "NASDAQ+semiconductor+chips+NVIDIA+AMD+Broadcom&hl=en-US&gl=US&ceid=US:en"
        ),

        (
            "AI",
            "https://news.google.com/rss/search?q="
            "NASDAQ+artificial+intelligence+AI+technology+stocks&hl=en-US&gl=US&ceid=US:en"
        ),

        (
            "Cloud",
            "https://news.google.com/rss/search?q="
            "NASDAQ+cloud+software+technology+stocks&hl=en-US&gl=US&ceid=US:en"
        ),
    ]

    # ------------------------------------------------------------------
    # Technology-company aliases
    #
    # Add/remove symbols according to the universe you trade.
    # The matching engine looks for either the ticker or company name.
    # ------------------------------------------------------------------

    SYMBOL_ALIASES = {
        "AAPL": ["apple", "aapl"],
        "MSFT": ["microsoft", "msft"],
        "NVDA": ["nvidia", "nvda"],
        "AMD": ["advanced micro devices", "amd"],
        "AVGO": ["broadcom", "avgo"],
        "GOOGL": ["alphabet", "google", "googl"],
        "GOOG": ["alphabet", "google", "goog"],
        "AMZN": ["amazon", "amzn"],
        "META": ["meta", "facebook", "meta platforms"],
        "TSLA": ["tesla", "tsla"],
        "NFLX": ["netflix", "nflx"],
        "ADBE": ["adobe", "adbe"],
        "CRM": ["salesforce", "crm"],
        "ORCL": ["oracle", "orcl"],
        "INTC": ["intel", "intc"],
        "QCOM": ["qualcomm", "qcom"],
        "MU": ["micron", "mu"],
        "AMAT": ["applied materials", "amat"],
        "LRCX": ["lam research", "lrcx"],
        "PANW": ["palo alto networks", "panw"],
        "CRWD": ["crowdstrike", "crwd"],
        "SNOW": ["snowflake", "snow"],
        "PLTR": ["palantir", "pltr"],
        "INTU": ["intuit", "intu"],
        "CSCO": ["cisco", "csco"],
        "ADSK": ["autodesk", "adsk"],
        "NOW": ["servicenow", "now"],
        "PYPL": ["paypal", "pypl"],
        "MELI": ["mercadolibre", "meli"],
        "ARM": ["arm holdings", "arm"],
        "MRVL": ["marvell", "mrvl"],
        "ASML": ["asml", "asml holding"],
        "MSTR": ["microstrategy", "strategy", "mstr"],
    }

    # ------------------------------------------------------------------
    # Finance-specific sentiment vocabulary
    # ------------------------------------------------------------------

    POSITIVE_WORDS = {
        "beat": 2.0,
        "beats": 2.0,
        "beating": 2.0,
        "strong": 1.5,
        "strength": 1.5,
        "surge": 2.0,
        "surges": 2.0,
        "surging": 2.0,
        "rally": 1.8,
        "rallies": 1.8,
        "gain": 1.2,
        "gains": 1.2,
        "growth": 1.5,
        "grow": 1.2,
        "growing": 1.2,
        "bullish": 2.0,
        "upgrade": 2.0,
        "upgraded": 2.0,
        "outperform": 2.0,
        "outperformed": 2.0,
        "positive": 1.3,
        "profit": 1.4,
        "profits": 1.4,
        "profitable": 1.5,
        "revenue": 0.4,
        "record": 1.5,
        "records": 1.5,
        "breakout": 1.8,
        "demand": 0.8,
        "stronger": 1.4,
        "accelerate": 1.4,
        "accelerating": 1.4,
        "innovation": 0.8,
        "optimistic": 1.5,
        "raises": 1.7,
        "raised": 1.7,
        "guidance": 0.3,
        "win": 1.2,
        "wins": 1.2,
        "contract": 0.8,
        "contracts": 0.8,
        "approval": 1.0,
        "approved": 1.0,
    }

    NEGATIVE_WORDS = {
        "miss": -2.0,
        "misses": -2.0,
        "missed": -2.0,
        "weak": -1.5,
        "weakness": -1.5,
        "drop": -1.7,
        "drops": -1.7,
        "dropping": -1.7,
        "fall": -1.5,
        "falls": -1.5,
        "falling": -1.5,
        "decline": -1.5,
        "declines": -1.5,
        "declining": -1.5,
        "bearish": -2.0,
        "downgrade": -2.0,
        "downgraded": -2.0,
        "underperform": -2.0,
        "underperformed": -2.0,
        "negative": -1.5,
        "loss": -1.7,
        "losses": -1.7,
        "unprofitable": -1.7,
        "lawsuit": -1.0,
        "investigation": -1.3,
        "warning": -1.3,
        "warns": -1.3,
        "warning": -1.3,
        "cut": -1.5,
        "cuts": -1.5,
        "cutting": -1.5,
        "layoffs": -1.7,
        "layoff": -1.7,
        "slowing": -1.5,
        "slowdown": -1.5,
        "risk": -0.8,
        "risks": -0.8,
        "crash": -2.0,
        "crashes": -2.0,
        "recall": -1.3,
        "recalls": -1.3,
        "delay": -1.0,
        "delays": -1.0,
        "sanctions": -1.5,
        "ban": -1.2,
        "banned": -1.2,
        "shortfall": -1.7,
    }

    # Words which intensify nearby sentiment.
    INTENSIFIERS = {
        "very": 1.5,
        "significantly": 1.5,
        "substantially": 1.5,
        "sharply": 1.5,
        "major": 1.3,
        "massive": 1.5,
        "record": 1.3,
    }

    def start(self):
        self.position_qty = 0

        self.news_cache = {}
        self.last_news_refresh = 0

        self.ctx.log(
            "Nasdaq Tech News Sentiment initialised: "
            f"fast={self.fast_period}, "
            f"slow={self.slow_period}, "
            f"news_refresh={self.news_refresh_seconds}s"
        )

        # Do an initial news load.
        self._refresh_news()

    # ==================================================================
    # Main strategy
    # ==================================================================

    def on_bar(self, bar: Bar):

        # --------------------------------------------------------------
        # 1. Refresh news periodically
        # --------------------------------------------------------------

        now = time.time()

        if now - self.last_news_refresh >= self.news_refresh_seconds:
            self._refresh_news()

        # --------------------------------------------------------------
        # 2. Get price data
        # --------------------------------------------------------------

        df = self.ctx.get_data(
            bar.symbol,
            lookback=self.slow_period + 10
        )

        if df.empty or len(df) < self.slow_period:
            return

        fast = sma(df, self.fast_period)
        slow = sma(df, self.slow_period)

        fast_now = fast.iloc[-1]
        slow_now = slow.iloc[-1]

        price_bullish = fast_now > slow_now
        price_bearish = fast_now < slow_now

        # --------------------------------------------------------------
        # 3. Calculate news sentiment for this symbol
        # --------------------------------------------------------------

        sentiment, article_count = self._symbol_sentiment(bar.symbol)

        # --------------------------------------------------------------
        # 4. Convert price + news into a trading signal
        # --------------------------------------------------------------

        signal = self._get_signal(
            sentiment=sentiment,
            price_bullish=price_bullish,
            price_bearish=price_bearish,
            article_count=article_count
        )

        self.ctx.log(
            f"{bar.symbol} NEWS={sentiment:.3f} "
            f"articles={article_count} "
            f"price={'BULLISH' if price_bullish else 'BEARISH'} "
            f"signal={signal}"
        )

        # --------------------------------------------------------------
        # 5. Execute
        # --------------------------------------------------------------

        if signal == "BUY":

            if self.position_qty <= 0:
                self.ctx.place_order(
                    bar.symbol,
                    "buy",
                    self.order_qty,
                    "market"
                )

                self.position_qty = self.order_qty

                self.ctx.log(
                    f"BUY {bar.symbol} @ {bar.close:.2f} "
                    f"(news={sentiment:.3f})"
                )

        elif signal == "SELL":

            if self.position_qty > 0:
                self.ctx.place_order(
                    bar.symbol,
                    "sell",
                    self.position_qty,
                    "market"
                )

                self.ctx.log(
                    f"SELL {bar.symbol} @ {bar.close:.2f} "
                    f"(news={sentiment:.3f})"
                )

                self.position_qty = 0

    # ==================================================================
    # Signal logic
    # ==================================================================

    def _get_signal(
        self,
        sentiment,
        price_bullish,
        price_bearish,
        article_count
    ):
        """
        Combine news sentiment and price trend.

        We require at least one relevant article. This prevents a
        missing/stale news feed from accidentally generating trades.
        """

        if article_count == 0:
            return "HOLD"

        # Strong positive news
        if sentiment >= self.strong_buy_threshold:

            if not self.require_price_confirmation:
                return "BUY"

            if price_bullish:
                return "BUY"

            # Positive news but price hasn't confirmed it yet.
            return "HOLD"

        # Strong negative news
        if sentiment <= self.strong_sell_threshold:

            if not self.require_price_confirmation:
                return "SELL"

            if price_bearish:
                return "SELL"

            return "HOLD"

        # Moderate positive news.
        # Don't buy unless price is already bullish.
        if sentiment >= self.buy_sentiment_threshold:
            if price_bullish:
                return "HOLD"

        # Moderate negative news.
        if sentiment <= self.sell_sentiment_threshold:
            if price_bearish:
                return "HOLD"

        return "HOLD"

    # ==================================================================
    # RSS handling
    # ==================================================================

    def _refresh_news(self):

        self.last_news_refresh = time.time()

        new_articles = []

        for feed_name, feed_url in self.RSS_FEEDS:

            try:
                articles = self._fetch_rss(
                    feed_name,
                    feed_url
                )

                new_articles.extend(articles)

            except Exception as exc:
                self.ctx.log(
                    f"RSS error [{feed_name}]: {exc}"
                )

        # Keep only recent articles.
        cutoff = time.time() - (
            self.news_lookback_hours * 60 * 60
        )

        recent_articles = [
            article
            for article in new_articles
            if article["timestamp"] >= cutoff
        ]

        # De-duplicate by URL/title.
        unique = {}

        for article in recent_articles:

            key = (
                article.get("url")
                or article.get("title", "").lower()
            )

            unique[key] = article

        self.news_cache = unique

        self.ctx.log(
            f"News refresh complete: "
            f"{len(self.news_cache)} recent articles"
        )

    def _fetch_rss(self, feed_name, url):

        request = urllib.request.Request(
            url,
            headers={
                "User-Agent":
                    "DeltaVantage-NewsStrategy/1.0"
            }
        )

        with urllib.request.urlopen(
            request,
            timeout=10
        ) as response:

            xml_data = response.read()

        root = ET.fromstring(xml_data)

        articles = []

        # Works with RSS 2.0 and most simple RSS feeds.
        for item in root.findall(".//item"):

            title = self._xml_text(
                item.find("title")
            )

            description = self._xml_text(
                item.find("description")
            )

            link = self._xml_text(
                item.find("link")
            )

            pub_date = self._xml_text(
                item.find("pubDate")
            )

            timestamp = self._parse_date(pub_date)

            if not title:
                continue

            articles.append({
                "source": feed_name,
                "title": title,
                "description": description,
                "url": link,
                "timestamp": timestamp,
            })

            if len(articles) >= self.max_articles_per_feed:
                break

        return articles

    @staticmethod
    def _xml_text(element):

        if element is None:
            return ""

        return "".join(
            element.itertext()
        ).strip()

    @staticmethod
    def _parse_date(value):

        if not value:
            return time.time()

        try:
            dt = parsedate_to_datetime(value)

            if dt.tzinfo is None:
                dt = dt.replace(
                    tzinfo=timezone.utc
                )

            return dt.timestamp()

        except Exception:
            return time.time()

    # ==================================================================
    # Symbol matching
    # ==================================================================

    def _symbol_sentiment(self, symbol):

        symbol = symbol.upper()

        aliases = self.SYMBOL_ALIASES.get(
            symbol,
            [symbol.lower()]
        )

        relevant = []

        for article in self.news_cache.values():

            text = (
                article["title"]
                + " "
                + article["description"]
            ).lower()

            if self._article_mentions_symbol(
                text,
                aliases
            ):
                relevant.append(article)

        if not relevant:
            return 0.0, 0

        weighted_scores = []
        weights = []

        now = time.time()

        for article in relevant:

            text = (
                article["title"]
                + " "
                + article["description"]
            )

            score = self._sentiment_score(text)

            # Newer stories get greater weight.
            age_hours = max(
                0,
                (now - article["timestamp"]) / 3600
            )

            # Exponential decay.
            # Half-life is approximately 12 hours.
            decay = math.exp(
                -math.log(2) * age_hours / 12
            )

            weighted_scores.append(
                score * decay
            )

            weights.append(decay)

        if not weights:
            return 0.0, 0

        sentiment = (
            sum(weighted_scores)
            / sum(weights)
        )

        # Clamp to [-1, +1]
        sentiment = max(
            -1.0,
            min(1.0, sentiment)
        )

        return sentiment, len(relevant)

    @staticmethod
    def _article_mentions_symbol(
        text,
        aliases
    ):
        """
        Avoid matching ticker symbols inside unrelated words.

        Example:
            'AMD' should match
            'AMD announces new chip'

        but shouldn't accidentally match
            'dreamed'
        """

        for alias in aliases:

            if " " in alias:
                if alias in text:
                    return True

            else:
                pattern = (
                    r"\b"
                    + re.escape(alias)
                    + r"\b"
                )

                if re.search(pattern, text):
                    return True

        return False

    # ==================================================================
    # Sentiment
    # ==================================================================

    def _sentiment_score(self, text):

        text = text.lower()

        # Remove punctuation.
        words = re.findall(
            r"\b[a-zA-Z]+\b",
            text
        )

        if not words:
            return 0.0

        total = 0.0
        matches = 0

        for i, word in enumerate(words):

            value = 0.0

            if word in self.POSITIVE_WORDS:
                value = self.POSITIVE_WORDS[word]

            elif word in self.NEGATIVE_WORDS:
                value = self.NEGATIVE_WORDS[word]

            if value == 0:
                continue

            # Look at the previous two words for an intensifier.
            modifier = 1.0

            start = max(0, i - 2)

            previous_words = words[start:i]

            for previous in previous_words:

                if previous in self.INTENSIFIERS:
                    modifier *= self.INTENSIFIERS[
                        previous
                    ]

            total += value * modifier
            matches += 1

        if matches == 0:
            return 0.0

        # Normalize by number of sentiment-bearing words.
        score = total / (
            2.0 * math.sqrt(matches)
        )

        # Clamp.
        return max(
            -1.0,
            min(1.0, score)
        )

    # ==================================================================
    # Shutdown
    # ==================================================================

    def stop(self):

        self.ctx.log(
            "Strategy stopped. "
            f"Final position: {self.position_qty}"
        )