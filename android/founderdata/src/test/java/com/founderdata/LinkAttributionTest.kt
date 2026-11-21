package com.founderdata

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LinkAttributionTest {
    private fun source(url: String) = LinkAttribution.fromUrl(url)

    @Test fun readsUtmRefAndWebVisitor() {
        assertEquals(
            WireSource(
                utmSource = "tiktok", utmMedium = "social", utmCampaign = "oct", utmTerm = "launch", utmContent = "v2",
                ref = "friend", webVisitorId = "abc123def456",
            ),
            source("https://example.com/open?utm_source=tiktok&utm_medium=social&utm_campaign=oct&utm_term=launch&utm_content=v2&ref=friend&rt_vid=abc123def456"),
        )
    }

    @Test fun customSchemeWorks() {
        assertEquals("newsletter", source("shipkit://item/42?utm_source=newsletter")?.utmSource)
    }

    @Test fun linkWithoutParametersHasNoSource() {
        assertNull(source("https://example.com/item/42"))
        assertNull(source("https://example.com/item/42?id=7&lang=en"))
        assertNull(source("https://example.com/?utm_source="))
        assertNull(source("mailto:someone@example.com"))
    }

    @Test fun namesAreCaseInsensitiveAndFirstValueWins() {
        val src = source("https://example.com/?UTM_Source=a&utm_source=b&Ref=x")
        assertEquals("a", src?.utmSource)
        assertEquals("x", src?.ref)
    }

    @Test fun percentEncodingIsDecodedAndPlusStays() {
        assertEquals("black friday", source("https://example.com/?utm_campaign=black%20friday")?.utmCampaign)
        assertEquals("black+friday", source("https://example.com/?utm_campaign=black+friday")?.utmCampaign)
        assertEquals("café", source("https://example.com/?utm_campaign=caf%C3%A9")?.utmCampaign)
        assertEquals("100%", source("https://example.com/?utm_campaign=100%")?.utmCampaign)
    }

    @Test fun fragmentIsIgnored() {
        assertEquals("x", source("https://example.com/?utm_source=x#utm_source=y")?.utmSource)
    }

    @Test fun invalidWebVisitorIdIsIgnored() {
        assertNull(source("https://example.com/?rt_vid=short"))
        assertNull(source("https://example.com/?rt_vid=has%20space%20inside"))
        assertNull(source("https://example.com/?rt_vid=${"a".repeat(65)}"))
        assertEquals("12345678", source("https://example.com/?rt_vid=12345678")?.webVisitorId)
        assertEquals("web_visitor-1", source("https://example.com/?rt_vid=web_visitor-1&ref=x")?.webVisitorId)
    }

    @Test fun readsTheOlderMlVidParameter() {
        assertEquals("web_visitor-2", source("https://example.com/?ml_vid=web_visitor-2")?.webVisitorId)
        assertEquals("new_visitor_1", source("https://example.com/?ml_vid=old_visitor_1&rt_vid=new_visitor_1")?.webVisitorId)
    }

    @Test fun longValuesAreClipped() {
        assertEquals(200, source("https://example.com/?utm_campaign=${"x".repeat(500)}")?.utmCampaign?.length)
    }

    @Test fun readsAdClickIds() {
        assertEquals(WireSource(clickNetwork = "google_ads", clickId = "Cj0KCQiA-abc_123"), source("https://example.com/open?gclid=Cj0KCQiA-abc_123"))
        assertEquals("google_ads", source("https://example.com/?wbraid=ABCDEFGH12")?.clickNetwork)
        assertEquals("microsoft_ads", source("https://example.com/?msclkid=0f1e2d3c4b5a")?.clickNetwork)
        assertEquals("E.C.P.abc123+/=", source("https://example.com/?ttclid=E.C.P.abc123+/=")?.clickId)
        assertEquals("x_ads", source("https://example.com/?twclid=2-abcdefgh")?.clickNetwork)
        assertEquals("linkedin_ads", source("https://example.com/?li_fat_id=7c1b9e7a-1111")?.clickNetwork)
        assertEquals("reddit_ads", source("https://example.com/?rdt_cid=1234567890123")?.clickNetwork)
        assertEquals("snapchat_ads", source("https://example.com/?ScCid=abcdef123456")?.clickNetwork)
        assertEquals("pinterest_ads", source("https://example.com/?epik=dj0yJnU9abc")?.clickNetwork)
        val tagged = source("https://example.com/?utm_source=google&utm_medium=cpc&gclid=abcdefgh12")
        assertEquals("google", tagged?.utmSource)
        assertEquals("abcdefgh12", tagged?.clickId)
    }

    @Test fun clickIdOrderMatchesTheServer() {
        assertEquals("google_ads", source("https://example.com/?msclkid=bbbbbbbb11&gclid=aaaaaaaa11")?.clickNetwork)
        assertEquals("aaaaaaaa22", source("https://example.com/?gbraid=bbbbbbbb22&gclid=aaaaaaaa22")?.clickId)
    }

    @Test fun invalidClickIdsAreIgnored() {
        assertNull(source("https://example.com/?gclid=%7Bgclid%7D"))
        assertNull(source("https://example.com/?gclid=short"))
        assertNull(source("https://example.com/?gclid=${"a".repeat(501)}"))
        assertEquals(500, source("https://example.com/?gclid=${"a".repeat(500)}")?.clickId?.length)
        assertEquals("microsoft_ads", source("https://example.com/?gclid=%7Bgclid%7D&msclkid=abcdefgh12")?.clickNetwork)
    }

    @Test fun aLaterLinkReplacesTheClickAsAPair() {
        val first = WireSource(utmSource = "x", clickNetwork = "google_ads", clickId = "aaaaaaaa11")
        assertEquals("aaaaaaaa11", first.merging(WireSource(utmSource = "y")).clickId)
        val merged = first.merging(WireSource(clickNetwork = "tiktok_ads", clickId = "bbbbbbbb22"))
        assertEquals("tiktok_ads", merged.clickNetwork)
        assertEquals("bbbbbbbb22", merged.clickId)
    }

    @Test fun clickIdsEncodeForTheServer() {
        val json = Json.write(WireSource(clickNetwork = "google_ads", clickId = "abcdefgh12").toJson())
        assertEquals("""{"click_id":"abcdefgh12","click_network":"google_ads"}""", json)
        assertEquals("abcdefgh12", WireSource.fromJson(parse(json) as Map<*, *>).clickId)
    }

    /** The Play Install Referrer's `installReferrer` string is a query string (docs/APP-API.md, section 9). */
    @Test fun readsTheInstallReferrerString() {
        assertEquals(
            WireSource(utmSource = "google-play", utmMedium = "organic"),
            LinkAttribution.fromQuery("utm_source=google-play&utm_medium=organic"),
        )
        assertEquals(
            WireSource(utmSource = "google", utmMedium = "cpc", utmCampaign = "spring sale", clickNetwork = "google_ads", clickId = "EAIaIQobChMI_abc"),
            LinkAttribution.fromQuery("utm_source=google&utm_medium=cpc&utm_campaign=spring%20sale&gclid=EAIaIQobChMI_abc"),
        )
        assertEquals("site_web_123", LinkAttribution.fromQuery("ref=blog&rt_vid=site_web_123")?.webVisitorId)
        assertNull(LinkAttribution.fromQuery(""))
        assertNull(LinkAttribution.fromQuery("&&="))
    }

    @Test fun coldLaunchLinkFillsTheNewSession() {
        val h = Harness()
        try {
            h.core.appBecameActive()
            h.core.record(Core.Action.Screen("Home"))
            h.clock.advance(2)
            h.core.attach(WireSource(utmSource = "tiktok"))
            assertEquals(listOf(WireEventType.SESSION_START, WireEventType.SCREEN), h.queued.map { it.t })
            assertEquals("tiktok", h.queued.first().src?.utmSource)
        } finally {
            h.cleanUp()
        }
    }

    @Test fun laterLinkStartsANewSession() {
        val h = Harness()
        try {
            h.core.appBecameActive()
            h.clock.advance(120)
            h.core.attach(WireSource(ref = "newsletter"))
            val events = h.queued
            assertEquals(listOf(WireEventType.SESSION_START, WireEventType.PING, WireEventType.SESSION_START), events.map { it.t })
            assertEquals("s1", events[1].sid)
            assertEquals(120_000L, events[1].d)
            assertEquals("s2", events[2].sid)
            assertEquals("newsletter", events[2].src?.ref)
        } finally {
            h.cleanUp()
        }
    }

    @Test fun linkBeforeAnySessionStartsOne() {
        val h = Harness()
        try {
            h.core.attach(WireSource(webVisitorId = "web_visitor_1"))
            assertEquals(listOf(WireEventType.SESSION_START), h.queued.map { it.t })
            assertEquals("web_visitor_1", h.queued.first().src?.webVisitorId)
        } finally {
            h.cleanUp()
        }
    }
}
