# Bầy Bot Minecraft (mineflayer) – Termux + APK

```
server/   Bot chạy trong Termux (Node.js + mineflayer)
android/  App APK hiển thị và điều khiển (WebView + vân tay)
.github/  Tự build APK trên GitHub Actions
```

## 1. Chạy bot trong Termux
```bash
pkg update -y && pkg upgrade -y
pkg install nodejs-lts git -y
cd mc-bot-swarm/server
npm install
termux-wake-lock        # giữ máy không ngủ
npm start               # in ra TOKEN, nhập 1 lần vào app
```
Server chỉ lắng nghe `127.0.0.1:8080` (app trên cùng điện thoại), cần đúng token mới kết nối được.

## 2. Build APK
Up cả thư mục này lên GitHub (nhớ có thư mục `.github`). Actions tự build, tải APK ở mục Releases (tag `latest`) hoặc Artifacts.

## 3. Dùng app
- **BOT**: thêm server, thêm bot (nhiều bot cùng lúc), Chạy/Dừng. Xanh = chạy, đỏ = dừng, vàng = đang kết nối.
- **Hành vi BOT**: máu, đói, tọa độ, túi đồ, đồ đang cầm, chế độ, bản đồ radar.
- **Điều khiển / Đa điều khiển**: gõ thường = AI xử lý; có dấu `-` = gửi thẳng.
- **An toàn**: Dừng khẩn cấp (vân tay), chủ nhân, giới hạn RAM/số bot.

Lệnh `-`: `-goto x y z` `-follow [tên]` `-come` `-mine|-collect khối [số]` `-attack [hostile|tên]`
`-guard [off]` `-craft vật_phẩm [số]` `-enchant [vật_phẩm]` `-equip vật_phẩm` `-drop vật_phẩm|all [số]`
`-give vật_phẩm [số]` `-place khối [x y z]` `-break x y z` `-eat` `-say chữ` `-inv` `-stop`

Trong game (chủ nhân đã thêm ở mục An toàn): `/msg TênBot -follow` hoặc `/msg TênBot chặt 10 gỗ`.

Bot tự `/register mk mk` hoặc `/login mk` khi server yêu cầu (mật khẩu đặt khi thêm bot).

## 4. AI local (tùy chọn)
```bash
pkg install llama-cpp -y
curl -L -o qwen.gguf https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf
llama-server -m qwen.gguf --port 8081 -c 2048
```
Không bật AI thì lệnh thường vẫn chạy bằng bộ phân tích dự phòng (hiểu các câu tiếng Việt đơn giản).
