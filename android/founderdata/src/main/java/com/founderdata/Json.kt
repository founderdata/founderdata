package com.founderdata

/**
 * A small JSON writer and reader, so the SDK needs no JSON library and encodes the same bytes on the JVM and on
 * Android. The writer sorts object keys and leaves `/` unescaped, like the Swift SDK's encoder, and drops null
 * values. Numbers are written as integers when they are whole.
 */
internal object Json {
    fun write(value: Any?): String = StringBuilder().also { append(it, value) }.toString()

    fun append(out: StringBuilder, value: Any?) {
        when (value) {
            null -> out.append("null")
            is String -> appendString(out, value)
            is Boolean -> out.append(if (value) "true" else "false")
            is Int, is Long, is Short, is Byte -> out.append(value.toString())
            is Double -> if (value % 1.0 == 0.0 && kotlin.math.abs(value) < 1e15) out.append(value.toLong()) else out.append(value)
            is Float -> append(out, value.toDouble())
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for (key in value.keys.map { it.toString() }.sorted()) {
                    val v = value[key] ?: continue
                    if (!first) out.append(',')
                    first = false
                    appendString(out, key)
                    out.append(':')
                    append(out, v)
                }
                out.append('}')
            }
            is Iterable<*> -> {
                out.append('[')
                var first = true
                for (v in value) {
                    if (!first) out.append(',')
                    first = false
                    append(out, v)
                }
                out.append(']')
            }
            else -> appendString(out, value.toString())
        }
    }

    private fun appendString(out: StringBuilder, s: String) {
        out.append('"')
        for (ch in s) {
            when (ch) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\b' -> out.append("\\b")
                '\u000C' -> out.append("\\f")
                else -> if (ch < ' ') out.append(String.format("\\u%04x", ch.code)) else out.append(ch)
            }
        }
        out.append('"')
    }

    /** Parses JSON text into maps, lists, strings, longs, doubles, booleans and null. Throws on bad input. */
    fun parse(text: String): Any? {
        val p = Parser(text)
        val v = p.value()
        p.skipSpace()
        if (p.i != text.length) throw IllegalArgumentException("trailing characters at ${p.i}")
        return v
    }

    private class Parser(val s: String) {
        var i = 0

        fun skipSpace() {
            while (i < s.length && s[i].isWhitespace()) i++
        }

        fun value(): Any? {
            skipSpace()
            if (i >= s.length) throw IllegalArgumentException("unexpected end")
            return when (val c = s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c.isDigit()) num() else throw IllegalArgumentException("unexpected '$c' at $i")
            }
        }

        private fun literal(word: String, v: Any?): Any? {
            if (!s.startsWith(word, i)) throw IllegalArgumentException("bad literal at $i")
            i += word.length
            return v
        }

        private fun obj(): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            i++
            skipSpace()
            if (s.getOrNull(i) == '}') { i++; return out }
            while (true) {
                skipSpace()
                val key = str()
                skipSpace()
                expect(':')
                out[key] = value()
                skipSpace()
                when (s.getOrNull(i)) {
                    ',' -> i++
                    '}' -> { i++; return out }
                    else -> throw IllegalArgumentException("expected , or } at $i")
                }
            }
        }

        private fun arr(): List<Any?> {
            val out = ArrayList<Any?>()
            i++
            skipSpace()
            if (s.getOrNull(i) == ']') { i++; return out }
            while (true) {
                out.add(value())
                skipSpace()
                when (s.getOrNull(i)) {
                    ',' -> i++
                    ']' -> { i++; return out }
                    else -> throw IllegalArgumentException("expected , or ] at $i")
                }
            }
        }

        private fun expect(c: Char) {
            if (s.getOrNull(i) != c) throw IllegalArgumentException("expected $c at $i")
            i++
        }

        private fun str(): String {
            expect('"')
            val sb = StringBuilder()
            while (true) {
                if (i >= s.length) throw IllegalArgumentException("unterminated string")
                val c = s[i++]
                when (c) {
                    '"' -> return sb.toString()
                    '\\' -> {
                        when (val e = s.getOrNull(i++)) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) throw IllegalArgumentException("bad escape")
                                sb.append(s.substring(i, i + 4).toInt(16).toChar())
                                i += 4
                            }
                            else -> throw IllegalArgumentException("bad escape $e")
                        }
                    }
                    else -> sb.append(c)
                }
            }
        }

        private fun num(): Any {
            val start = i
            if (s[i] == '-') i++
            while (i < s.length && (s[i].isDigit() || s[i] in ".eE+-")) i++
            val text = s.substring(start, i)
            return text.toLongOrNull() ?: text.toDouble()
        }
    }
}

// Typed reads from parsed JSON.
internal fun Map<*, *>.str(key: String): String? = this[key] as? String
internal fun Map<*, *>.long(key: String): Long? = (this[key] as? Number)?.toLong()
internal fun Map<*, *>.bool(key: String): Boolean? = this[key] as? Boolean
internal fun Map<*, *>.obj(key: String): Map<*, *>? = this[key] as? Map<*, *>
internal fun Map<*, *>.list(key: String): List<*>? = this[key] as? List<*>

@Suppress("UNCHECKED_CAST")
internal fun Map<*, *>.stringMap(key: String): Map<String, String>? =
    obj(key)?.entries?.mapNotNull { (k, v) -> if (k is String && v is String) k to v else null }?.toMap()
