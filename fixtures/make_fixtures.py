# -*- coding: utf-8 -*-
"""生成"坏文件"测试夹具，用于验证 docx 通道的格式闸门。
    每个夹具对应一条必须被明确拒绝的路径（不许静默放行、不许产出半截数据）。
"""
import os, zipfile, struct

OUT = os.path.dirname(os.path.abspath(__file__))          # 脚本就在 fixtures/ 里，夹具就落在旁边
os.makedirs(OUT, exist_ok=True)

def w(name, data):
    p = os.path.join(OUT, name)
    with open(p, 'wb') as f:
        f.write(data)
    print('  %-22s %6d 字节' % (name, os.path.getsize(p)))

# ① .doc 老格式（OLE2 复合文件头）
ole2 = bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) + b'\x00' * 504
w('old_format.doc', ole2)

# ② 合法 zip，但没有 word/document.xml
p = os.path.join(OUT, 'no_document.zip')
with zipfile.ZipFile(p, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('hello.txt', '这不是一个 docx')
print('  %-22s %6d 字节' % ('no_document.zip', os.path.getsize(p)))

# ③ 合法 docx 结构，但正文里没有任何段落
p = os.path.join(OUT, 'no_paragraphs.docx')
with zipfile.ZipFile(p, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    z.writestr('word/document.xml',
               '<?xml version="1.0" encoding="UTF-8"?>'
               '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
               '<w:body><w:sectPr/></w:body></w:document>')
print('  %-22s %6d 字节' % ('no_paragraphs.docx', os.path.getsize(p)))

# ④ 完全不是 zip/ole2 的随机字节
w('random.bin', bytes([(i * 37 + 11) % 251 for i in range(4096)]))

# ⑤ 0 字节空文件
w('empty.docx', b'')

# ⑥ 被截断的 docx（取真样卷的一半）
src = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sample.docx')   # 真样卷在仓库根目录
with open(src, 'rb') as f:
    raw = f.read()
w('truncated.docx', raw[:len(raw) // 2])

# ⑦ 只有 PK 头但内部结构乱（伪造 zip 签名 + 垃圾）
w('fake_zip.docx', b'PK\x03\x04' + b'\xff' * 200)

print('  夹具目录:', OUT)
