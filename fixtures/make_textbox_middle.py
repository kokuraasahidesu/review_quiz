# -*- coding: utf-8 -*-
"""追加夹具：文本框在中间的 docx —— 用来证明"穿透文本框不会吃掉后文"。"""
import os, zipfile
OUT = os.path.dirname(os.path.abspath(__file__))          # 脚本就在 fixtures/ 里，夹具就落在旁边
NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"')

def p(text, bold=False):
    rpr = '<w:rPr><w:b/></w:rPr>' if bold else ''
    return '<w:p><w:r>%s<w:t xml:space="preserve">%s</w:t></w:r></w:p>' % (rpr, text)

# 文本框：故意夹在两道正文题中间
box = ('<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>'
       '<wp:inline><wp:extent cx="5000000" cy="900000"/><wp:docPr id="1" name="tb"/>'
       '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
       '<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr/><wps:txbx><w:txbxContent>'
       + p(u'【判断】2. 文本框里的题目：地球是圆的。（　）')
       + p(u'答案：√')
       + '</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp>'
       '</a:graphicData></a:graphic></wp:inline></w:drawing></mc:Choice></mc:AlternateContent></w:r></w:p>')

body = (p(u'【单选】1. 正文第一题：1+1=?')
        + p(u'A. 1') + p(u'B. 2') + p(u'答案：B')
        + box
        + p(u'【单选】3. 正文第三题（在文本框之后，绝不能丢）：2+2=?')
        + p(u'A. 3') + p(u'B. 4') + p(u'答案：B'))

doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
       '<w:document %s><w:body>%s<w:sectPr/></w:body></w:document>') % (NS, body)

path = os.path.join(OUT, 'textbox_middle.docx')
with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    z.writestr('word/document.xml', doc)
print('  textbox_middle.docx  %d 字节' % os.path.getsize(path))