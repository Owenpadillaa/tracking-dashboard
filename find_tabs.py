with open('dashboard.html','r',encoding='utf-8',newline='') as f:
    content = f.read()

# Find all tab-page divs
import re
# Find id='tab-X' divs that are tab pages
for m in re.finditer(r'<div[^>]*id=\"(tab-[^\"]+)\"[^>]*class=\"[^\"]*tab-page[^\"]*\"[^>]*>', content):
    start = m.start()
    end = min(start + 2000, len(content))
    snippet = content[start:end]
    print('--- Found:', m.group(1), '---')
    print(snippet[:500])
    print()

# Also check for data-tab attributes on buttons
for m in re.finditer(r'data-tab=\"([^\"]+)\"', content):
    print('Tab button:', m.group(0), '->', m.group(1))