// Unit tests for src/lib/sanitizeHtml.ts: the allowlist sanitizer behind the long text of a landing
// article. Pure function, no database. The tables are the adversarial part: every row is an input
// with the exact output the contract demands; on top of that EVERY input of every table (and a few
// thousand random ones) must produce output that is well formed, only made of allowed pieces and
// stable under a second pass.
import { describe, expect, it } from 'vitest'
import { ALLOWED_TAGS, DROP_CONTENT_TAGS, sanitizeHref, sanitizeHtml } from '../src/lib/sanitizeHtml'

/** The link the sanitizer writes for a kept <a>. */
const link = (href: string, inner: string) =>
  `<a href="${href}" rel="noopener noreferrer nofollow" target="_blank">${inner}</a>`

type Row = [input: string, expected: string]

// ---- strict grammar of a result ------------------------------------------------------------------

const PLAIN_TAGS = 'p|strong|b|em|i|u|h2|h3|ul|ol|li|blockquote'
const TAG_RE = new RegExp(
  `<(?:(${PLAIN_TAGS})|/(${PLAIN_TAGS}|a)|(br)|a href="((?:[^"<>&]|&(?:amp|lt|gt|quot);)*)" rel="noopener noreferrer nofollow" target="_blank")>`,
  'y',
)
const REF_RE = /&(?:#\d+;?|#[xX][0-9a-fA-F]+;?|[A-Za-z][A-Za-z0-9]*;)/y
const SAFE_HREF = /^(?:https?:\/\/[^/?#\s]|mailto:\S)/i

/** Null when `out` is exactly what the sanitizer is allowed to produce, otherwise what is wrong. */
function grammarError(out: string): string | null {
  const stack: string[] = []
  let i = 0
  while (i < out.length) {
    const c = out[i]
    if (c === '<') {
      TAG_RE.lastIndex = i
      const m = TAG_RE.exec(out)
      if (!m) return `tag at ${i} is not allowed: ${out.slice(i, i + 40)}`
      if (m[1]) stack.push(m[1])
      else if (m[2]) {
        const top = stack.pop()
        if (top !== m[2]) return `</${m[2]}> at ${i} closes ${top}`
      } else if (m[4] !== undefined) {
        stack.push('a')
        const href = m[4]
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
        if (!SAFE_HREF.test(href)) return `href is not an allowed URL: ${href}`
        if (/[\u0000-\u001f\u007f]/.test(href)) return 'control character in href'
      }
      i = TAG_RE.lastIndex
    } else if (c === '>' || c === '"') {
      return `raw ${c} at ${i}`
    } else if (c === '&') {
      REF_RE.lastIndex = i
      if (!REF_RE.exec(out)) return `bare & at ${i}: ${out.slice(i, i + 20)}`
      i = REF_RE.lastIndex
    } else {
      i++
    }
  }
  if (stack.length) return `unclosed: ${stack.join(', ')}`
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(out)) return 'control character in text'
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)) {
    return 'unpaired surrogate'
  }
  // trimmed: HTML whitespace only (String#trim would also strip no-break space, U+2028 ...)
  if (/^[ \t\n\f\r]|[ \t\n\f\r]$/.test(out)) return 'not trimmed'
  return null
}

/** Well formed, only allowed pieces, and a second pass changes nothing. */
function expectSafeAndStable(input: string) {
  const out = sanitizeHtml(input)
  expect(grammarError(out), JSON.stringify(input)).toBeNull()
  expect(sanitizeHtml(out), `second pass of ${JSON.stringify(input)}`).toBe(out)
  return out
}

// ---- tables ----------------------------------------------------------------------------------------

/** Input already in the allowed form: comes out unchanged. */
const KEPT: string[] = [
  '<p>Hello</p>',
  '<p>a <strong>b</strong> <b>c</b> <em>d</em> <i>e</i> <u>f</u></p>',
  '<h2>Heading 2</h2><h3>Heading 3</h3>',
  '<ul><li>one</li><li>two</li></ul>',
  '<ol><li>one</li><li>two</li></ol>',
  '<blockquote><p>quoted</p></blockquote>',
  '<p>line one<br>line two</p>',
  '<p>สวัสดีครับ <strong>ทุกคน</strong> 😀</p>',
  '<ul><li>a<ul><li>nested</li></ul>b</li></ul>',
  'text without any tag',
  '<p>one</p>\n<p>two</p>',
  '<b><b><b>x</b></b></b>',
  '<p>&lt;b&gt; is not bold &amp; &quot;quoted&quot;</p>',
  '<p>\u00a0</p>',
  '<p>tab\tnewline\ncr\r\nform feed\f</p>',
]

const NORMALIZED: Row[] = [
  ['<P>UP</P><STRONG>S</STRONG>', '<p>UP</p><strong>S</strong>'],
  ['<p class="a" id=b style=\'c\' data-x=d onclick=e>t</p>', '<p>t</p>'],
  ['<p onmouseover="alert(1)" onclick=\'alert(2)\' onfocus=alert(3)>t</p>', '<p>t</p>'],
  ['<b style="x">b</b><i class=c>i</i><u id="d">u</u><em lang=th>e</em>', '<b>b</b><i>i</i><u>u</u><em>e</em>'],
  ['<ul class="x"><li style="y">l</li></ul>', '<ul><li>l</li></ul>'],
  ['<br><br/><br />text<BR>', '<br><br><br>text<br>'],
  ['<br class="x" id=y>', '<br>'],
  ['<br>x</br>', '<br>x'],
  ['<p>&nbsp;</p>', '<p>\u00a0</p>'],
  ['&nbsp;&#160;&#xA0;x', '\u00a0\u00a0\u00a0x'],
  ['<p/>text', '<p>text</p>'],
  ['<strong/>text', '<strong>text</strong>'],
  ['<p\n>newline</p\n>', '<p>newline</p>'],
  ['<p\t>tab</p\t>', '<p>tab</p>'],
  ['<p/ >slash space</p>', '<p>slash space</p>'],
  ['<p ====>weird</p>', '<p>weird</p>'],
  ['<p "quoted">weird</p>', '<p>weird</p>'],
  ['<p a=\'b>c</p>d\'>t</p>', '<p>t</p>'],
  ['<p a="b>c</p>d">t</p>', '<p>t</p>'],
  ['<p a=b>c</p>', '<p>c</p>'],
  ['   leading and trailing   ', 'leading and trailing'],
  ['\n\n<p>x</p>\n\n', '<p>x</p>'],
  ['   ', ''],
  ['\t\n', ''],
  ['', ''],
]

const LINKS: Row[] = [
  // kept: http, https and mailto, whatever the quoting; rel and target are forced
  ['<a href="https://example.com">x</a>', link('https://example.com', 'x')],
  ["<a href='http://example.com/a?b=1&c=2'>x</a>", link('http://example.com/a?b=1&amp;c=2', 'x')],
  ['<a href=https://example.com/path>x</a>', link('https://example.com/path', 'x')],
  ['<a\nhref\n=\n"https://example.com"\n>x</a>', link('https://example.com', 'x')],
  ['<A HREF="https://example.com">x</A>', link('https://example.com', 'x')],
  ['<a href="mailto:me@example.com?subject=hi&amp;body=yo">mail</a>', link('mailto:me@example.com?subject=hi&amp;body=yo', 'mail')],
  ['<a href="HTTP://EXAMPLE.COM">x</a>', link('HTTP://EXAMPLE.COM', 'x')],
  ['<a href="  https://example.com  ">x</a>', link('https://example.com', 'x')],
  ['<a href="https://exa\nmple.com">x</a>', link('https://example.com', 'x')],
  ['<a href="https://a.example"><b>bold</b> text</a>', link('https://a.example', '<b>bold</b> text')],
  ['<a href="https://a.example">unclosed', link('https://a.example', 'unclosed')],
  // forced rel / target: the input cannot choose them
  [
    '<a href="https://example.com" target="_self" rel="opener" onclick="evil()" style="x" class=y>x</a>',
    link('https://example.com', 'x'),
  ],
  ['<a target=_top rel=help href="https://example.com">x</a>', link('https://example.com', 'x')],
  // the first href wins, like in a browser
  ['<a href="https://ok.example" href="javascript:alert(1)">x</a>', link('https://ok.example', 'x')],
  ['<a href="javascript:alert(1)" href="https://ok.example">x</a>', 'x'],
  // quotes inside the URL cannot break out of the attribute
  [
    '<a href="https://ok.example?q=&quot;onmouseover=&quot;alert(1)">x</a>',
    link('https://ok.example?q=&quot;onmouseover=&quot;alert(1)', 'x'),
  ],
  [
    '<a href=\'https://ok.example/"onmouseover="alert(1)\'>x</a>',
    link('https://ok.example/&quot;onmouseover=&quot;alert(1)', 'x'),
  ],
  ['<a href="https://ok.example/&lt;script&gt;">x</a>', link('https://ok.example/&lt;script&gt;', 'x')],
  [
    '<a href="https://ok.example/?a=1&b=2&amp;c=3&copy=4&notanentity;">x</a>',
    link('https://ok.example/?a=1&amp;b=2&amp;c=3&amp;copy=4&amp;notanentity;', 'x'),
  ],
  ['<a href="https://ok.example" "onmouseover=alert(1)>x</a>', link('https://ok.example', 'x')],
  // unwrapped: the tag goes, the text stays (and so does formatting inside it)
  ['<a href="javascript:alert(1)">x</a>', 'x'],
  ['<a href="JaVaScRiPt:alert(1)">x</a>', 'x'],
  ['<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>', 'x'],
  ['<a href="data:image/svg+xml,<svg onload=alert(1)>">x</a>', 'x'],
  ['<a href="vbscript:msgbox(1)">x</a>', 'x'],
  ['<a href="file:///etc/passwd">x</a>', 'x'],
  ['<a href="ftp://example.com/x">x</a>', 'x'],
  ['<a href="tel:+66123">x</a>', 'x'],
  ['<a href="sms:+66123">x</a>', 'x'],
  ['<a href="//evil.example/x">x</a>', 'x'],
  ['<a href="/relative/path">x</a>', 'x'],
  ['<a href="relative.html">x</a>', 'x'],
  ['<a href="#frag">x</a>', 'x'],
  ['<a href="?q=1">x</a>', 'x'],
  ['<a href="">x</a>', 'x'],
  ['<a href>x</a>', 'x'],
  ['<a href=>x</a>', 'x'],
  ['<a name="x">x</a>', 'x'],
  ['<a>x</a>', 'x'],
  ['<a href="https://">x</a>', 'x'],
  ['<a href="https:///evil.example">x</a>', 'x'],
  ['<a href="https:/example.com">x</a>', 'x'],
  ['<a href="https:\\\\example.com">x</a>', 'x'],
  ['<a href="mailto:">x</a>', 'x'],
  ['<a href=`https://ok.example`>x</a>', 'x'],
  ['<a href="javascript:alert(1)"><b>bold</b> text</a>', '<b>bold</b> text'],
  // entity-encoded and whitespace-obfuscated schemes
  ['<a href="jav&#x09;ascript:alert(1)">x</a>', 'x'],
  ['<a href="jav&#x0A;ascript:alert(1)">x</a>', 'x'],
  ['<a href="jav&#10;ascript:alert(1)">x</a>', 'x'],
  ['<a href="jav&#13;ascript:alert(1)">x</a>', 'x'],
  ['<a href="&#106;avascript:alert(1)">x</a>', 'x'],
  ['<a href="&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1)">x</a>', 'x'],
  ['<a href="&#106&#97&#118&#97&#115&#99&#114&#105&#112&#116&#58;alert(1)">x</a>', 'x'],
  ['<a href="java&Tab;script&colon;alert(1)">x</a>', 'x'],
  ['<a href="javascript&colon;alert(1)">x</a>', 'x'],
  ['<a href="&#x64;ata:text/html,<script>alert(1)</script>">x</a>', 'x'],
  ['<a href="vb&#x73;cript:msgbox(1)">x</a>', 'x'],
  ['<a href="\u0001javascript:alert(1)">x</a>', 'x'],
  ['<a href=" \n\t javascript:alert(1)">x</a>', 'x'],
  ['<a href="\u0000javascript:alert(1)">x</a>', 'x'],
  ['<a href="java\u0000script:alert(1)">x</a>', 'x'],
  ['<a href="&#0;javascript:alert(1)">x</a>', 'x'],
  ['<a href="&#x1;javascript:alert(1)">x</a>', 'x'],
  ['<a href="&Tab;javascript:alert(1)">x</a>', 'x'],
  ['<a href="\u2028javascript:alert(1)">x</a>', 'x'],
  ['<a href="\u00a0javascript:alert(1)">x</a>', 'x'],
  ['<a href="&nbsp;javascript:alert(1)">x</a>', 'x'],
  // malformed anchors
  ['<a/href="javascript:alert(1)">x</a>', 'x'],
  ['<a\u000bhref="javascript:alert(1)">x</a>', 'x'],
  ['<a href="https://a.example', ''],
  ['<a href="https://a.example"', ''],
  ["<a href='https://a.example>x</a>", ''],
  // an <a> never contains another <a>: the second one starts a new link
  [
    '<a href="https://a.example">one <a href="https://b.example">two</a> three</a>',
    link('https://a.example', 'one ') + link('https://b.example', 'two') + ' three',
  ],
  [
    '<a href="https://a.example">one <a href="javascript:x">two</a> three</a>',
    link('https://a.example', 'one two') + ' three',
  ],
]

/** Disallowed tags that are not on the drop list: the tag goes, its text stays. */
const TEXT_KEPT: Row[] = [
  ['<div>a</div><div>b</div>', 'ab'],
  ['<span style="color:red" class="c" id="i">red</span>', 'red'],
  ['<h1>Title</h1><h4>Sub</h4>', 'TitleSub'],
  ['<table><tr><td>cell</td></tr></table>', 'cell'],
  ['<font color=red>old</font><center>c</center><marquee>m</marquee>', 'oldcm'],
  ['<o:p>office</o:p><x-custom>c</x-custom>', 'officec'],
  ['<code>c</code><pre>p</pre><hr><sup>s</sup><del>d</del>', 'cpsd'],
  ['<html><body>x</body></html>', 'x'],
  ['<div onclick="alert(1)"><p>keep <b>this</b></p></div>', '<p>keep <b>this</b></p>'],
  ['<section><article><p>deep</p></article></section>', '<p>deep</p>'],
  ['<xmp><b>x</b></xmp>', '<b>x</b>'],
  ['<plaintext><b>x</b>', '<b>x</b>'],
]

/** script / style and friends: raw text that ends at the first matching end tag. */
const RAW_TEXT: Row[] = [
  ['<style>p{color:red}</style>after', 'after'],
  ['<style>a{}</style >after', 'after'],
  ['<style>a{}</STYLE>after', 'after'],
  ['<style>a{}</style/>after', 'after'],
  ['<style>a{}</style\n>after', 'after'],
  ['<style>a{}</style x="y>z">after', 'after'],
  ['<style>a{}</styles>still style</style>after', 'after'],
  ['<style>a{}</style', ''],
  ['<style>/* </style> */ b{} </style>after', '*/ b{} after'],
  ['<script>var a = "</scr" + "ipt>";</script>after', 'after'],
  ['<script>alert(1)</script <b>x</b>', 'x'],
  ['<script src=//evil.example/x.js></script>t', 't'],
  ['<script/src=//evil.example/x.js>alert(1)</script>t', 't'],
  ['<script type="text/template"><p>hi</p></script>t', 't'],
  ['<SCRIPT>alert(1)</SCRIPT>t', 't'],
  ['<scRipt>alert(1)</sCrIpT>t', 't'],
  ['<script >alert(1)</script >t', 't'],
  ['<script\n>alert(1)</script>t', 't'],
  ['<script/**/>alert(1)</script>t', 't'],
  ['<script>alert(1)', ''],
  ['<script><b>x</b>', ''],
  ['<textarea><b>x</b></textarea>t', 't'],
  ['<title><b>x</b></title>t', 't'],
  ['<noscript><p title="</noscript><img src=x onerror=alert(1)>">t</p></noscript>u', '&quot;&gt;tu'],
  ['<iframe src="javascript:alert(1)"></iframe>t', 't'],
  ['<iframe srcdoc="<script>alert(1)</script>"></iframe>t', 't'],
  ['<iframe>fallback</iframe>t', 't'],
  ['<iframe/src=x>t', ''],
]

/** Dropped elements with markup content, void ones, svg / math. */
const DROPPED: Row[] = [
  ['<object data="x"><param name=a value=b>alt</object>t', 't'],
  ['<embed src=x>t', 't'],
  ['<video><source src=x>fallback</video>t', 't'],
  ['<picture><source srcset=x><img src=y></picture>t', 't'],
  ['<canvas>fallback</canvas>t', 't'],
  ['<button onclick=x>Click</button>t', 't'],
  ['<form action=x><input name=a><button>go</button>inside</form>t', 't'],
  ['<select><option>a<option>b</select>t', 't'],
  ['<option>stray</option>t', 't'],
  ['<template><p>hi</p><template>nested</template>more</template>t', 't'],
  ['<head><title>T</title><meta charset=x></head><body><p>b</p></body>', '<p>b</p>'],
  ['<head><title>T</title><body><p>b</p>', '<p>b</p>'],
  ['<html><head></head><body>x</body></html>', 'x'],
  ['<svg><script>alert(1)</script></svg>t', 't'],
  ['<svg onload=alert(1)>t', ''],
  ['<svg/onload=alert(1)>t', ''],
  ['<svg/>t', 't'],
  ['<svg><g><circle/></g></svg>t', 't'],
  ['<svg><svg>inner</svg>still svg</svg>t', 't'],
  ['<svg><style><b>x</b></style></svg>t', 't'],
  ['<svg><![CDATA[<script>alert(1)</script>]]></svg>t', 't'],
  ['<svg><!-- </svg> --><p>still svg</p></svg>t', 't'],
  ['<math><mi>x</mi></math>t', 't'],
  ['<math/>t', 't'],
  ['<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>', ''],
  ['<math><mi//xlink:href="data:x,<script>alert(4)</script>">t', ''],
  ['<img src=x onerror=alert(1)>t', 't'],
  ['<img src="x" onerror="alert(1)"/>t', 't'],
  ['<img/src=x/onerror=alert(1)>t', 't'],
  ['<IMG SRC=JaVaScRiPt:alert(1)>t', 't'],
  ['<img src=x onerror=alert(1)', ''],
  ['<img src="x"onerror="alert(1)">t', 't'],
  ['<input type=text value=x>t', 't'],
  ['<link rel=stylesheet href=//evil.example/x.css>t', 't'],
  ['<meta http-equiv=refresh content="0;url=//evil.example">t', 't'],
  ['<base href=//evil.example/>t', 't'],
  ['<source src=x>t', 't'],
]

const COMMENTS: Row[] = [
  ['a<!-- c -->b', 'ab'],
  ['a<!---->b', 'ab'],
  ['a<!-->b', 'ab'],
  ['a<!--->b', 'ab'],
  ['a<!-- c --!>b', 'ab'],
  ['a<!-- c -- >b-->c', 'ac'],
  ['a<!-- <!-- nested --> still -->b', 'a still --&gt;b'],
  ['a<!--[if IE]><script>alert(1)</script><![endif]-->b', 'ab'],
  ['a<!-- <script>alert(1)</script> -->b', 'ab'],
  ['a<!-- <p>hidden</p> --><p>shown</p>', 'a<p>shown</p>'],
  ['a<!-- unterminated <b>x</b>', 'a'],
  ['a<!--', 'a'],
  ['a<!-', 'a'],
  ['a<!', 'a'],
  ['a<!DOCTYPE html>b', 'ab'],
  ['a<!doctype html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">b', 'ab'],
  ['a<![CDATA[ <b>x</b> > y ]]>b', 'ab'],
  ['a<![CDATA[ unterminated <b>x</b>', 'a'],
  ['a<![endif]>b', 'ab'],
  ['a<?xml version="1.0" encoding="UTF-8"?>b', 'ab'],
  ['a<?php echo "x"; ?>b', 'ab'],
  ['a<?>b', 'ab'],
  ['a<? unterminated', 'a'],
  ['a</>b', 'ab'],
  ['a</ >b', 'ab'],
  ['a</3>b', 'ab'],
  ['a</ b>c</b>', 'ac'],
]

/** Characters that are not markup, and tags that never finish. */
const TEXT_AND_BROKEN: Row[] = [
  ['1 < 2 and 3 > 2', '1 &lt; 2 and 3 &gt; 2'],
  ['a<3 b', 'a&lt;3 b'],
  ['a <> b', 'a &lt;&gt; b'],
  ['a << b', 'a &lt;&lt; b'],
  ['a<\nb', 'a&lt;\nb'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['<<', '&lt;&lt;'],
  ['<<<b>x</b>', '&lt;&lt;<b>x</b>'],
  ['< p>not a tag</ p>', '&lt; p&gt;not a tag'],
  ['a</', 'a&lt;/'],
  ['a</b', 'a'],
  ['a<b', 'a'],
  ['<<img src=x onerror=alert(1)//', '&lt;'],
  ['say "hi" & \'bye\'', 'say &quot;hi&quot; &amp; \'bye\''],
]

const NESTING: Row[] = [
  ['<p>unclosed', '<p>unclosed</p>'],
  ['<p><b><i>deep', '<p><b><i>deep</i></b></p>'],
  ['stray</p>end</b>', 'strayend'],
  ['</a></li></ul></blockquote>', ''],
  ['<b><i>x</b>y</i>z', '<b><i>x</i></b>yz'],
  ['<p>a<p>b<p>c', '<p>a</p><p>b</p><p>c</p>'],
  ['<ul><li>a<li>b<li>c</ul>', '<ul><li>a</li><li>b</li><li>c</li></ul>'],
  ['<ul><li>a<ul><li>b</ul>c</ul>', '<ul><li>a<ul><li>b</li></ul>c</li></ul>'],
  ['<ol><li><p>one<li><p>two</ol>', '<ol><li><p>one</p></li><li><p>two</p></li></ol>'],
  ['<h2>a<h3>b', '<h2>a</h2><h3>b</h3>'],
  ['<h2>a</h3>b', '<h2>ab</h2>'],
  ['<p>a<h2>b</h2>c</p>', '<p>a</p><h2>b</h2>c'],
  ['<p>a<ul><li>b</li></ul>c</p>', '<p>a</p><ul><li>b</li></ul>c'],
  ['<blockquote><p>q</blockquote>after', '<blockquote><p>q</p></blockquote>after'],
  ['<p><a href="https://a.example">x</p>y</a>', '<p>' + link('https://a.example', 'x') + '</p>y'],
]

/** Character references and escaping. */
const ESCAPING: Row[] = [
  ['&amp; &lt; &gt; &quot; &apos; &nbsp; &copy; &hellip;', "&amp; &lt; &gt; &quot; ' \u00a0 &copy; &hellip;"],
  ['&#60;script&#62;alert(1)&#60;/script&#62;', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['&#x3C;script&#x3E;', '&lt;script&gt;'],
  ['&lt;script&gt;alert(1)&lt;/script&gt;', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['&amp;lt;', '&amp;lt;'],
  ['&amp;amp;', '&amp;amp;'],
  ['AT&T and R&D', 'AT&amp;T and R&amp;D'],
  ['a & b && c', 'a &amp; b &amp;&amp; c'],
  ['&', '&amp;'],
  ['&;', '&amp;;'],
  ['&#;', '&amp;#;'],
  ['&#x;', '&amp;#x;'],
  ['&#65;&#x42;&#67', 'ABC'],
  ['&notanentity; &Amp; &AMP; &LT; &Gt;', '&notanentity; &Amp; &amp; &lt; &Gt;'],
  ['&ampx; &amp &lt', '&ampx; &amp;amp &amp;lt'],
  ['\u00a0nbsp\u00a0raw', '\u00a0nbsp\u00a0raw'],
  ['emoji 😀 thai สวัสดีครับ ๑๒๓', 'emoji 😀 thai สวัสดีครับ ๑๒๓'],
  ['<p title="&quot;>&lt;script&gt;">x</p>', '<p>x</p>'],
  ['&#0;', '�'],
  ['&#xD800;&#xDFFF;&#x110000;&#99999999999;', '����'],
  ['a&#1;b&#127;c&#9;d', 'abc\td'],
]

/** NUL, other control characters and broken UTF-16. */
const CONTROL: Row[] = [
  ['a\u0000b\u0001c\u0008d\u000be\u001ff\u007fg', 'abcdefg'],
  ['<scr\u0000ipt>alert(1)</scr\u0000ipt>t', 't'],
  ['<a href="https://ok.example/\u0000">x</a>', link('https://ok.example/', 'x')],
  ['<p\u0000>x</p>', '<p>x</p>'],
  ['\u0000', ''],
  ['\u0000<script>alert(1)</script>\u0000', ''],
  ['lone \ud800 high and \udc00 low and pair 😀 ok', 'lone � high and � low and pair 😀 ok'],
  ['tab\tkept\nnewline\rcr\fff', 'tab\tkept\nnewline\rcr\fff'],
]

/** Tags split, nested and mangled to survive a naive filter. */
const SPLIT: Row[] = [
  ['<scr<script>ipt>alert(1)</scr</script>ipt>', 'ipt&gt;alert(1)ipt&gt;'],
  ['<<script>script>alert(1)<</script>/script>', '&lt;/script&gt;'],
  ['<scr<!-- -->ipt>alert(1)</scr<!-- -->ipt>', 'ipt&gt;alert(1)ipt&gt;'],
  ['<scr\nipt>alert(1)</script>', 'alert(1)'],
  ['<ScRiPt>alert(1)</ScRiPt>', ''],
  ['<script>alert(1)</script>t', 't'],
  ['<scr&#x69;pt>alert(1)</script>t', 'alert(1)t'],
  ['<sty<style>le>x</sty</style>le>', 'le&gt;xle&gt;'],
  ['<ifra<iframe>me src=x>', 'me src=x&gt;'],
  ['<<a href="javascript:alert(1)">x</a>', '&lt;x'],
  ['<a href="java<!-- -->script:alert(1)">x</a>', 'x'],
  ['<b <script>alert(1)</script>>x</b>', '<b>alert(1)&gt;x</b>'],
  ['<p <img src=x onerror=alert(1)>>x</p>', '<p>&gt;x</p>'],
]

const TABLES: Row[][] = [
  NORMALIZED,
  LINKS,
  TEXT_KEPT,
  RAW_TEXT,
  DROPPED,
  COMMENTS,
  TEXT_AND_BROKEN,
  NESTING,
  ESCAPING,
  CONTROL,
  SPLIT,
]

// ---- tests -----------------------------------------------------------------------------------------

describe('the lists', () => {
  it('allows exactly p br strong b em i u h2 h3 ul ol li blockquote a', () => {
    expect([...ALLOWED_TAGS].sort()).toEqual(
      ['a', 'b', 'blockquote', 'br', 'em', 'h2', 'h3', 'i', 'li', 'ol', 'p', 'strong', 'u', 'ul'].sort(),
    )
  })

  it('drops the whole content of exactly the 26 tags of the contract', () => {
    expect([...DROP_CONTENT_TAGS].sort()).toEqual(
      [
        'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'title',
        'textarea', 'select', 'option', 'form', 'input', 'button', 'link', 'meta', 'base', 'head', 'img',
        'video', 'audio', 'source', 'picture', 'canvas',
      ].sort(),
    )
  })
})

describe('allowed tags', () => {
  it.each(KEPT)('keeps %j unchanged', (input) => {
    expect(sanitizeHtml(input)).toBe(input)
    expectSafeAndStable(input)
  })

  it.each(NORMALIZED)('%j', (input, expected) => {
    expect(sanitizeHtml(input)).toBe(expected)
  })
})

describe('links', () => {
  it.each(LINKS)('%j', (input, expected) => {
    expect(sanitizeHtml(input)).toBe(expected)
  })

  it('every kept link carries rel="noopener noreferrer nofollow" and target="_blank"', () => {
    const out = sanitizeHtml(
      '<a href="https://a.example">1</a><a href="http://b.example" rel="x" target="y">2</a><a href="mailto:c@d.ef">3</a>',
    )
    const tags = out.match(/<a [^>]*>/g) ?? []
    expect(tags).toHaveLength(3)
    for (const t of tags) {
      expect(t).toMatch(/^<a href="[^"]+" rel="noopener noreferrer nofollow" target="_blank">$/)
    }
  })

  it('sanitizeHref keeps only absolute http, https and mailto URLs, read the way a browser reads them', () => {
    expect(sanitizeHref('https://example.com/a?b=1&amp;c=2')).toBe('https://example.com/a?b=1&c=2')
    expect(sanitizeHref('  mailto:me@example.com\n')).toBe('mailto:me@example.com')
    expect(sanitizeHref('ht\ttps://exam\nple.com')).toBe('https://example.com')
    expect(sanitizeHref('&#104;ttps&colon;//example.com')).toBe('https://example.com')
    for (const bad of [
      '',
      ' ',
      'javascript:alert(1)',
      'jav&#x09;ascript:alert(1)',
      '&#106;avascript:alert(1)',
      'data:text/html,<b>x</b>',
      'vbscript:x',
      '//example.com',
      '/a/b',
      'example.com',
      'https://',
      'https:///x',
      'mailto:',
      'https://ex\u0001ample.com',
    ]) {
      expect(sanitizeHref(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('tags that are removed but keep their text', () => {
  it.each(TEXT_KEPT)('%j', (input, expected) => {
    expect(sanitizeHtml(input)).toBe(expected)
  })
})

describe('tags that are removed with everything inside', () => {
  const VOID = new Set(['embed', 'input', 'link', 'meta', 'base', 'img', 'source'])
  const withContent = DROP_CONTENT_TAGS.filter((t) => !VOID.has(t))

  it.each(withContent)('<%s> and its content go, the text around it stays', (tag) => {
    expect(sanitizeHtml(`a<${tag} x=1>inner <b>bold</b> text</${tag}>b`)).toBe('ab')
    expect(sanitizeHtml(`a<${tag.toUpperCase()}>inner</${tag.toUpperCase()}>b`)).toBe('ab')
    expect(sanitizeHtml(`a<${tag}>inner</${tag} >b`)).toBe('ab')
    expect(sanitizeHtml(`<p>a</p><${tag}><p>inner</p></${tag}><p>b</p>`)).toBe('<p>a</p><p>b</p>')
  })

  it.each(withContent)('an unclosed <%s> drops everything after it', (tag) => {
    expect(sanitizeHtml(`a<${tag}>unclosed <b>x</b> to the end`)).toBe('a')
  })

  it.each([...VOID])('<%s> has no content: only the tag itself goes', (tag) => {
    expect(sanitizeHtml(`a<${tag} src=x onerror=alert(1) href="javascript:1">b`)).toBe('ab')
    expect(sanitizeHtml(`a<${tag.toUpperCase()}/>b`)).toBe('ab')
  })

  it.each(DROPPED)('%j', (input, expected) => {
    expect(sanitizeHtml(input)).toBe(expected)
  })

  it.each(RAW_TEXT)('raw text: %j', (input, expected) => {
    expect(sanitizeHtml(input)).toBe(expected)
  })
})

describe('comments, CDATA, doctype and processing instructions', () => {
  it.each(COMMENTS)('%j', (input, expected) => {
    expect(sanitizeHtml(input)).toBe(expected)
  })
})

describe('text, broken tags and escaping', () => {
  it.each(TEXT_AND_BROKEN)('%j', (input, expected) => {
    expect(sanitizeHtml(input)).toBe(expected)
  })

  it.each(ESCAPING)('%j', (input, expected) => {
    expect(sanitizeHtml(input)).toBe(expected)
  })

  it.each(CONTROL)('%j', (input, expected) => {
    expect(sanitizeHtml(input)).toBe(expected)
  })

  it('escapes & < > " in text and in the link target, and nothing else', () => {
    expect(sanitizeHtml('a & b < c > d " e \' f')).toBe("a &amp; b &lt; c &gt; d &quot; e ' f")
    expect(sanitizeHtml('<a href="https://x.example/?a=1&b=<2>&c=&quot;">t</a>')).toBe(
      link('https://x.example/?a=1&amp;b=&lt;2&gt;&amp;c=&quot;', 't'),
    )
  })

  it('returns an empty string for an empty or non-string input', () => {
    expect(sanitizeHtml('')).toBe('')
    expect(sanitizeHtml(undefined as unknown as string)).toBe('')
    expect(sanitizeHtml(null as unknown as string)).toBe('')
    expect(sanitizeHtml(5 as unknown as string)).toBe('')
  })
})

describe('split, nested and mangled tags', () => {
  it.each(SPLIT)('%j', (input, expected) => {
    expect(sanitizeHtml(input)).toBe(expected)
  })
})

describe('well formed output', () => {
  it.each(NESTING)('%j', (input, expected) => {
    expect(sanitizeHtml(input)).toBe(expected)
  })

  it('closes what is left open and drops what was never opened', () => {
    expect(sanitizeHtml('<ul><li><b><i>a')).toBe('<ul><li><b><i>a</i></b></li></ul>')
    expect(sanitizeHtml('</i></b></li></ul>x')).toBe('x')
  })

  it('a stray end tag does not close a different element of the same family', () => {
    expect(sanitizeHtml('<h2>a</h3>b</h2>c')).toBe('<h2>ab</h2>c')
    expect(sanitizeHtml('<ul><li>a</ol>b</li></ul>')).toBe('<ul><li>ab</li></ul>')
  })
})

describe('invariants', () => {
  const inputs = [
    ...KEPT,
    ...TABLES.flatMap((rows) => rows.map(([input]) => input)),
    ...TABLES.flatMap((rows) => rows.map(([, expected]) => expected)),
  ]

  it('every input of every table gives well formed, allowed-only, stable output', () => {
    expect(inputs.length).toBeGreaterThan(300)
    for (const input of inputs) expectSafeAndStable(input)
  })

  it('never lets an active construct through, whatever is wrapped around it', () => {
    const payloads = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<svg onload=alert(1)></svg>',
      '<a href="javascript:alert(1)">x</a>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<body onload=alert(1)>',
      '<style>*{x:expression(alert(1))}</style>',
      '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
      '<form action="javascript:alert(1)"><button>x</button></form>',
      '<object data="javascript:alert(1)"></object>',
      '<embed src="javascript:alert(1)">',
      '<base href="javascript:alert(1)//">',
      '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
      '<input onfocus=alert(1) autofocus>',
      '<video><source onerror=alert(1)></video>',
      '<details open ontoggle=alert(1)>x</details>',
      '<p style="background:url(javascript:alert(1))">x</p>',
    ]
    const wrappers: ((p: string) => string)[] = [
      (p) => p,
      (p) => `<p>${p}</p>`,
      (p) => `<b>${p}`,
      (p) => `<!-- ${p} -->${p}`,
      (p) => `<noscript>${p}</noscript>${p}`,
      (p) => `<<${p}`,
      (p) => p.toUpperCase(),
      (p) => p.replace(/ /g, '\n'),
      (p) => p.replace(/ /g, '\t'),
      (p) => p.replace(/ /g, '/'),
      (p) => `<a href="https://ok.example">${p}</a>`,
    ]
    for (const payload of payloads) {
      for (const wrap of wrappers) {
        const out = expectSafeAndStable(wrap(payload))
        expect(out, wrap(payload)).not.toMatch(/<(?!\/?(?:p|strong|b|em|i|u|h2|h3|ul|ol|li|blockquote|br|a)\b)/i)
        expect(out, wrap(payload)).not.toMatch(/\bon\w+\s*=/i)
        expect(out, wrap(payload)).not.toMatch(/\bstyle\s*=/i)
        expect(out, wrap(payload)).not.toMatch(/href="\s*(?!https?:|mailto:)/i)
      }
    }
  })

  it('is idempotent on a document that mixes everything', () => {
    const doc = inputs.join('\n')
    const once = sanitizeHtml(doc)
    expect(grammarError(once)).toBeNull()
    expect(sanitizeHtml(once)).toBe(once)
  })
})

describe('random inputs', () => {
  // Small deterministic PRNG so a failure can be reproduced.
  const mulberry32 = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const FRAGMENTS = [
    '<p>', '</p>', '<b>', '</b>', '<i>', '</i>', '<strong>', '<em>', '<u>', '</u>', '<br>', '<br/>', '</br>',
    '<ul>', '</ul>', '<ol>', '<li>', '</li>', '<h2>', '</h2>', '<h3>', '</h3>', '<blockquote>', '</blockquote>',
    '<a href="https://x.co/a?b=1&amp;c=2">', '<a href=javascript:alert(1)>', "<a href='", '<a href="java&#x09;script:alert(1)">',
    '<a href=" https://ok.example/p ">', '<a href="mailto:a@b.c">', '<a href>', '<a>', '</a>', '<a href="HTTPS://UP.example">',
    '"', "'", '>', '<', '</', '<!--', '-->', '--!>', '<!-->', '<!--->', '<![CDATA[', ']]>', '<?', '?>', '<!DOCTYPE html>', '<!x>',
    '<script>', '</script>', '</script ', '<svg>', '</svg>', '<svg/>', '<style>', '</style', '</style>', '<img src=x onerror=alert(1)>',
    '<input>', '<noscript>', '</noscript>', '<textarea>', '</textarea>', '<title>', '</title>', '<template>', '</template>',
    '<form>', '</form>', '<select><option>', '</select>', '<math>', '</math>', '<object>', '</object>', '<iframe>', '</iframe>',
    '<head>', '</head>', '<body>', '<html>', '<video>', '</video>', '<button>', '</button>', '<embed src=x>', '<meta charset=x>',
    '&amp;', '&lt;', '&gt;', '&quot;', '&nbsp;', '&copy;', '&#106;', '&#x6A;', '&#0;', '&#1;', '&#xD800;', '&#x110000;',
    '&#99999999999999999;', '&', '&#', '&#x', ';', '&amp', '&notanentity;',
    'text', ' ', '\n', '\t', '\r\n', '\0', '\u0001', '\u007f', '=', '/', 'javascript:', 'java\tscript:', 'ไทย', '😀', '\ud800',
    '\udc00', 'x', 'ab', 'on', 'click', 'href', 'scr', 'ipt', '<scr', 'ipt>', '<P onclick=1>', '<P ONCLICK="a>b">',
    '<a  HREF = "https://sp.example/a b" >', '<div>', '</div>', '<span style="x">', '</span>', '<h1>', '<table>', '\u00a0', '\u2028',
  ]
  const ALPHABET = '<>/!-?"\'=& ;#xXaApPbBsS0189\n\t[]'

  it('3000 random fragment mixes and 3000 random character strings: always safe and stable', () => {
    const rand = mulberry32(20261114)
    for (let k = 0; k < 3000; k++) {
      let mix = ''
      for (let j = 1 + Math.floor(rand() * 30); j > 0; j--) mix += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]
      expectSafeAndStable(mix)
      let chars = ''
      for (let j = 1 + Math.floor(rand() * 60); j > 0; j--) chars += ALPHABET[Math.floor(rand() * ALPHABET.length)]
      expectSafeAndStable(chars)
    }
  })
})

describe('large and hostile inputs (linear time)', () => {
  // Every one of these makes a backtracking regex or a "search again from the start" loop quadratic.
  // A linear sanitizer needs a few milliseconds for 60 KB and well under a second for 1.2 MB; a
  // quadratic one needs minutes for the latter, so the bound is far above the real time and far
  // below the failure time.
  const SHAPES: Record<string, (n: number) => string> = {
    'lone <': (n) => '<'.repeat(n),
    'lone &': (n) => '&'.repeat(n),
    '&a pairs': (n) => '&a'.repeat(n / 2),
    'long entity names': (n) => ('&' + 'a'.repeat(30)).repeat(n / 31),
    'one huge numeric reference': (n) => '&#' + '1'.repeat(n),
    'open <b>': (n) => '<b>'.repeat(n / 3),
    'stray end tags': (n) => '</b>'.repeat(n / 4),
    'deep stack, then stray end tags': (n) => '<b>'.repeat(n / 6) + '</i>'.repeat(n / 8),
    'open then close': (n) => '<b>'.repeat(n / 7) + '</b>'.repeat(n / 7),
    'unclosed <p>': (n) => '<p>'.repeat(n / 3),
    'unclosed <li>': (n) => '<ul>' + '<li>x'.repeat(n / 5) + '</ul>',
    'nested links': (n) => '<a href="https://x.co">'.repeat(n / 24),
    'repeated <!--': (n) => '<!--'.repeat(n / 4),
    'comment of dashes': (n) => '<!--' + '-'.repeat(n),
    'comment of --!': (n) => '<!--' + '--!'.repeat(n / 3),
    'repeated <script>': (n) => '<script>'.repeat(n / 8),
    'script without end': (n) => '<script>' + 'x'.repeat(n),
    'script with near-miss end tags': (n) => '<script>' + '</scriptx'.repeat(n / 9),
    'style with near-miss end tags': (n) => '<style>' + '</style'.repeat(n / 7),
    'nested <svg>': (n) => '<svg>'.repeat(n / 5),
    'nested <svg> closed': (n) => '<svg>'.repeat(n / 11) + '</svg>'.repeat(n / 11),
    'nested <form>': (n) => '<form>'.repeat(n / 6),
    'attribute names': (n) => '<a ' + 'x '.repeat(n / 2) + '>',
    'attributes with values': (n) => '<a ' + 'x=y '.repeat(n / 4) + '>',
    'unterminated quote': (n) => '<a href="' + 'x'.repeat(n),
    'repeated unterminated quotes': (n) => '<a x="'.repeat(n / 6),
    'tags that never end': (n) => '<a'.repeat(n / 2),
    'repeated <![CDATA[': (n) => '<![CDATA['.repeat(n / 9),
    'repeated <!x': (n) => '<!x'.repeat(n / 3),
    'repeated <?': (n) => '<?'.repeat(n / 2),
    'repeated </ ': (n) => '</ '.repeat(n / 3),
    'quotes (6x growth)': (n) => '"'.repeat(n),
    'no-break spaces': (n) => '\u00a0'.repeat(n),
    'controls': (n) => '\u0001\u0000'.repeat(n / 2),
    'lone surrogates': (n) => '\ud800'.repeat(n),
    'huge href': (n) => '<a href="https://x.co/' + 'a&amp;'.repeat(n / 6) + '">t</a>',
    'huge href of tabs': (n) => '<a href="https://x.co/' + '\t'.repeat(n) + '">t</a>',
  }

  it.each(Object.keys(SHAPES))('%s: 60 KB, safe and stable', (name) => {
    const input = SHAPES[name](60_000)
    const started = performance.now()
    const out = sanitizeHtml(input)
    expect(performance.now() - started).toBeLessThan(1500)
    expect(grammarError(out)).toBeNull()
    expect(sanitizeHtml(out)).toBe(out)
  })

  it('1.2 MB of each shape is still fast', () => {
    const started = performance.now()
    for (const make of Object.values(SHAPES)) sanitizeHtml(make(1_200_000))
    // all 38 shapes together: about 1 s when linear, minutes when any one of them is quadratic
    expect(performance.now() - started).toBeLessThan(25_000)
  })
})
