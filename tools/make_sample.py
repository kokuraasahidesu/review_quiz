# -*- coding: utf-8 -*-
"""
生成测试样卷 sample.docx —— 故意把难 case 全塞进去，用来验证解析器：
  1) 四种题型标记【单选】【多选】【判断】【简答】
  2) 简答关键词的三种标记方式：加粗 / 高亮 / 字体颜色
  3) 一行里混排（粗体关键词夹在普通文字中间）—— 考验 run 级样式跟踪
  4) 文本框（w:txbxContent）里的题目 —— mammoth 抓不到的那种
  5) 判断题的多种正误写法 + 一个"歧义无答案"的，应被标为待人工校对
  6) 答案解析标签的多种写法（答案：/【答案】/正确答案:）
"""
import zipfile, os

NS = (
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"'
)

def esc(t):
    return (t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))

def run(text, b=False, hl=None, color=None, u=False, shd=None):
    """一个 run；b=加粗 hl=高亮色 color=字体色 shd=底纹填充"""
    rpr = ''
    if b: rpr += '<w:b/>'
    if u: rpr += '<w:u w:val="single"/>'
    if color: rpr += '<w:color w:val="%s"/>' % color
    if hl: rpr += '<w:highlight w:val="%s"/>' % hl
    if shd: rpr += '<w:shd w:val="clear" w:color="auto" w:fill="%s"/>' % shd
    rpr = '<w:rPr>%s</w:rPr>' % rpr if rpr else ''
    return '<w:r>%s<w:t xml:space="preserve">%s</w:t></w:r>' % (rpr, esc(text))

def para(*runs):
    return '<w:p>%s</w:p>' % ''.join(runs)

def textbox(*paras):
    """模拟 Word 的文本框结构（含 mc:AlternateContent / wps:txbx / w:txbxContent）"""
    inner = ''.join(paras)
    return (
        '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>'
        '<wp:inline distT="0" distB="0" distL="0" distR="0">'
        '<wp:extent cx="5486400" cy="914400"/><wp:docPr id="1" name="文本框 1"/>'
        '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
        '<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr>'
        '<a:xfrm><a:off x="0" y="0"/><a:ext cx="5486400" cy="914400"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>'
        '<wps:txbx><w:txbxContent>%s</w:txbxContent></wps:txbx><wps:bodyPr/>'
        '</wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></mc:Choice></mc:AlternateContent></w:r></w:p>'
    ) % inner

body = []
# ---------- 标题 ----------
body.append(para(run('计算机网络 · 期中模拟卷（解析器测试样卷）', b=True)))

# ---------- 单选 ----------
body.append(para(run('【单选】1. 下列哪个协议工作在传输层？')))
body.append(para(run('A. HTTP')))
body.append(para(run('B. TCP')))
body.append(para(run('C. IP')))
body.append(para(run('D. ARP')))
body.append(para(run('答案：B')))
body.append(para(run('解析：HTTP 是应用层，IP 与 ARP 属于网络层，TCP 位于传输层。')))

# ---------- 单选（答案解析用另一种标签写法） ----------
body.append(para(run('【单选】2. IPv4 地址长度是多少位？')))
body.append(para(run('A. 32 位')))
body.append(para(run('B. 64 位')))
body.append(para(run('C. 128 位')))
body.append(para(run('D. 16 位')))
body.append(para(run('【答案】A')))
body.append(para(run('【解析】IPv4 为 32 位，IPv6 为 128 位。')))

# ---------- 多选 ----------
body.append(para(run('【多选】3. 下列哪些属于应用层协议？（多选）')))
body.append(para(run('A. DNS')))
body.append(para(run('B. FTP')))
body.append(para(run('C. TCP')))
body.append(para(run('D. SMTP')))
body.append(para(run('正确答案: ABD')))
body.append(para(run('解析：TCP 属于传输层，其余均为应用层。')))

# ---------- 判断（正常） ----------
body.append(para(run('【判断】4. 交换机工作在数据链路层。（　）')))
body.append(para(run('答案：√')))

# ---------- 判断（另一种写法） ----------
body.append(para(run('【判断】5. UDP 是面向连接的可靠传输协议。（　）')))
body.append(para(run('答案：错')))
body.append(para(run('解析：UDP 无连接、不可靠；面向连接且可靠的是 TCP。')))

# ---------- 判断（歧义：没给答案，应被标"待人工校对"） ----------
body.append(para(run('【判断】6. 集线器可以隔离冲突域。（　）')))
body.append(para(run('答案：待定')))

# ---------- 简答：关键词用「加粗」标记 ----------
body.append(para(run('【简答】7. 简述 TCP 三次握手的过程。')))
body.append(para(
    run('参考答案：客户端发送 '),
    run('SYN', b=True),
    run(' 报文并进入 SYN_SENT 状态；服务端回复 '),
    run('SYN+ACK', b=True),
    run(' 并进入 SYN_RCVD；客户端再发送 '),
    run('ACK', b=True),
    run(' 完成连接，双方进入 ESTABLISHED。')
))

# ---------- 简答：关键词用「高亮」标记 ----------
body.append(para(run('【简答】8. 简述 HTTP 与 HTTPS 的主要区别。')))
body.append(para(
    run('参考答案：HTTPS 在 HTTP 之下增加了 '),
    run('TLS/SSL', hl='yellow'),
    run(' 加密层，默认端口为 '),
    run('443', hl='yellow'),
    run('，需要 '),
    run('数字证书', hl='yellow'),
    run(' 验证服务端身份，因此能防窃听与篡改。')
))

# ---------- 简答：关键词用「字体颜色」标记 ----------
body.append(para(run('【简答】9. 说明 DNS 递归查询与迭代查询的区别。')))
body.append(para(
    run('参考答案：递归查询由 '),
    run('本地DNS服务器', color='FF0000'),
    run(' 代为完成全部解析；迭代查询则由 '),
    run('根域名服务器', color='FF0000'),
    run(' 只返回下一级 '),
    run('服务器地址', color='FF0000'),
    run('，由请求方继续追问。')
))

# ---------- 文本框里的题（mammoth 抓不到） ----------
body.append(textbox(
    para(run('【判断】10. 文本框里的题目：标准大气压下水的沸点是 100℃。（　）')),
    para(run('答案：√')),
    para(run('解析：此题干与答案都写在 Word 文本框里，用于验证解析器能否穿透文本框。'))
))

doc_xml = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    '<w:document %s><w:body>%s<w:sectPr/></w:body></w:document>'
) % (NS, ''.join(body))

content_types = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '</Types>'
)
rels = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    '</Relationships>'
)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sample.docx')
os.makedirs(os.path.dirname(out), exist_ok=True)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', content_types)
    z.writestr('_rels/.rels', rels)
    z.writestr('word/document.xml', doc_xml)

print('已生成:', out)
print('大小: %.1f KB' % (os.path.getsize(out) / 1024))
with zipfile.ZipFile(out) as z:
    info = z.getinfo('word/document.xml')
    print('document.xml: 压缩 %d 字节 -> 原始 %d 字节, 方法=%d(deflate)' % (info.compress_size, info.file_size, info.compress_type))
    x = z.read('word/document.xml').decode('utf-8')
print('含 <w:b/> :', x.count('<w:b/>'))
print('含 highlight:', x.count('w:highlight'))
print('含 color:', x.count('w:color w:val'))
print('含 txbxContent:', x.count('w:txbxContent'))
print('段落数 <w:p>:', x.count('<w:p>'))
