import os

# Find /api/v1/log/voice in server.js
with open('server.js','r',encoding='utf-8',newline='') as f:
    lines = f.readlines()

for i,l in enumerate(lines):
    if '/api/v1/log/voice' in l and 'app.' in l:
        print(f'Server route at line {i+1}')
        for j in range(i, min(i+55, len(lines))):
            print(f'{j+1}: {lines[j].rstrip()}')
        print('---')
        break

# Find showAuraToast in dashboard.html
with open('dashboard.html','r',encoding='utf-8',newline='') as f:
    html_lines = f.readlines()

for i,l in enumerate(html_lines):
    if 'showAuraToast' in l:
        print(f'showAuraToast around line {i+1}')
        for j in range(max(0,i-2), min(i+20, len(html_lines))):
            print(f'{j+1}: {html_lines[j].rstrip()}')
        print('---')
        break

# Find _voiceRecognition.onresult
for i,l in enumerate(html_lines):
    if '_voiceRecognition.onresult' in l:
        print(f'_voiceRecognition.onresult around line {i+1}')
        for j in range(i, min(i+35, len(html_lines))):
            print(f'{j+1}: {html_lines[j].rstrip()}')
        break