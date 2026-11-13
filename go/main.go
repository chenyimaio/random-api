// random-api —— 随机图片 / 随机一言 / 每日一句
// 单文件 HTTP 服务，零外部依赖，静态编译（CGO_ENABLED=0）。
package main

import (
	"encoding/json"
	"log"
	"math/rand"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- 数据结构 ----------

type Format struct {
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
}

type Image struct {
	Name          string            `json:"name"`
	Class         string            `json:"class"`
	Device        string            `json:"device"`
	Genre         string            `json:"genre"`
	Tags          []string          `json:"tags"`
	Orientation   string            `json:"orientation"`
	Width         int               `json:"width"`
	Height        int               `json:"height"`
	DefaultFormat string            `json:"defaultFormat"`
	Path          string            `json:"path"`
	Bytes         int64             `json:"bytes"`
	Formats       map[string]Format `json:"formats"`
}

type Quote struct {
	ID        int     `json:"id"`
	UUID      string  `json:"uuid,omitempty"`
	Hitokoto  string  `json:"hitokoto"`
	Type      string  `json:"type"`
	From      string  `json:"from"`
	FromWho   *string `json:"from_who"`
	Creator   string  `json:"creator"`
	CreatedAt string  `json:"created_at"`
	Length    int     `json:"length,omitempty"`
}

// ---------- 全局状态 ----------

var (
	mu      sync.RWMutex
	images  []Image
	quotes  []Quote
	byGenre = map[string][]Image{}
	byClass = map[string][]Image{}
	byType  = map[string][]Quote{}

	imgBase  string
	publicDi string
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// ---------- 数据加载 ----------

func loadImages(p string) error {
	b, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	var list []Image
	if err := json.Unmarshal(b, &list); err != nil {
		return err
	}
	g := map[string][]Image{}
	c := map[string][]Image{}
	for _, im := range list {
		g[im.Genre] = append(g[im.Genre], im)
		c[im.Class] = append(c[im.Class], im)
	}
	mu.Lock()
	images, byGenre, byClass = list, g, c
	mu.Unlock()
	log.Printf("images: %d 条 (genre=%d class=%d)", len(list), len(g), len(c))
	return nil
}

// 本地精编 + 远程句子库合并，按 id 去重
func loadQuotes(paths ...string) error {
	seen := map[int]bool{}
	var all []Quote
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			log.Printf("skip %s: %v", path.Base(p), err)
			continue
		}
		var list []Quote
		if err := json.Unmarshal(b, &list); err != nil {
			log.Printf("skip %s: %v", path.Base(p), err)
			continue
		}
		n := 0
		for _, q := range list {
			if q.Hitokoto == "" || seen[q.ID] {
				continue
			}
			seen[q.ID] = true
			all = append(all, q)
			n++
		}
		log.Printf("%s: %d 条, 新增 %d", path.Base(p), len(list), n)
	}
	t := map[string][]Quote{}
	for _, q := range all {
		t[q.Type] = append(t[q.Type], q)
	}
	mu.Lock()
	quotes, byType = all, t
	mu.Unlock()
	log.Printf("quotes: %d 条, 类型 %d 种", len(all), len(t))
	return nil
}

// ---------- 选择逻辑 ----------

func rnd(n int) int {
	if n <= 0 {
		return 0
	}
	return rand.Intn(n)
}

func parseTypes(raw string) []string {
	if raw == "" {
		return nil
	}
	var out []string
	for _, s := range strings.Split(raw, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func pickQuote(types []string) *Quote {
	mu.RLock()
	defer mu.RUnlock()
	if len(quotes) == 0 {
		return nil
	}
	pool := quotes
	if len(types) > 0 {
		pool = nil
		for _, t := range types {
			pool = append(pool, byType[t]...)
		}
	}
	if len(pool) == 0 {
		return nil
	}
	q := pool[rnd(len(pool))]
	return &q
}

// 每日一句：日期做 FNV 哈希，同一天全站同一句
func dailyQuote(day string) *Quote {
	mu.RLock()
	defer mu.RUnlock()
	if len(quotes) == 0 {
		return nil
	}
	h := uint32(2166136261)
	for i := 0; i < len(day); i++ {
		h ^= uint32(day[i])
		h *= 16777619
	}
	q := quotes[int(h)%len(quotes)]
	return &q
}

func pickImage(genre, device, class string) *Image {
	mu.RLock()
	defer mu.RUnlock()
	var pool []Image
	switch {
	case class != "":
		pool = byClass[class]
	case genre != "" && device != "":
		for _, im := range byGenre[genre] {
			if im.Device == device {
				pool = append(pool, im)
			}
		}
	case genre != "":
		pool = byGenre[genre]
	case device != "":
		for _, im := range images {
			if im.Device == device {
				pool = append(pool, im)
			}
		}
	default:
		pool = images
	}
	if len(pool) == 0 {
		return nil
	}
	im := pool[rnd(len(pool))]
	return &im
}

// ---------- 输出 ----------

func writeJSON(w http.ResponseWriter, status int, v any, cache string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if cache != "" {
		w.Header().Set("Cache-Control", cache)
	}
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func errJSON(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]string{"error": code, "message": msg}, "no-store")
}

func resolveFormat(im *Image, want string) (string, Format) {
	name := want
	f, ok := im.Formats[name]
	if name == "" || !ok {
		name = im.DefaultFormat
		f = im.Formats[name]
	}
	return name, f
}

// ---------- 路由 ----------

func handleRandom(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	genre := q.Get("genre")
	device := q.Get("device")
	class := q.Get("class")
	want := q.Get("format")

	im := pickImage(genre, device, class)
	if im == nil {
		errJSON(w, http.StatusNotFound, "no_image", "no image matched the filters")
		return
	}

	fmtName, f := resolveFormat(im, want)

	if q.Get("info") == "1" {
		out := map[string]any{
			"name":        im.Name,
			"class":       im.Class,
			"device":      im.Device,
			"genre":       im.Genre,
			"tags":        im.Tags,
			"orientation": im.Orientation,
			"width":       im.Width,
			"height":      im.Height,
			"bytes":       f.Bytes,
			"format":      fmtName,
			"url":         imgBase + f.Path,
			"defaultFormat": im.DefaultFormat,
			"formats":       im.Formats,
		}
		// 随机结果：绝不缓存，否则 CDN 会让所有人拿到同一张图
		writeJSON(w, http.StatusOK, out, "no-store")
		return
	}

	w.Header().Set("Cache-Control", "no-store, private")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	http.Redirect(w, r, imgBase+f.Path, http.StatusFound)
}

// handleImageInfo 始终返回 JSON 详情（/api/random?info=1 的等价别名）。
func handleImageInfo(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	im := pickImage(q.Get("genre"), q.Get("device"), q.Get("class"))
	if im == nil {
		errJSON(w, http.StatusNotFound, "no_image", "no image matched the filters")
		return
	}
	fmtName, f := resolveFormat(im, q.Get("format"))
	out := map[string]any{
		"name":          im.Name,
		"class":         im.Class,
		"device":        im.Device,
		"genre":         im.Genre,
		"tags":          im.Tags,
		"orientation":   im.Orientation,
		"width":         im.Width,
		"height":        im.Height,
		"bytes":         f.Bytes,
		"format":        fmtName,
		"url":           imgBase + f.Path,
		"defaultFormat": im.DefaultFormat,
		"formats":       im.Formats,
	}
	writeJSON(w, http.StatusOK, out, "no-store")
}

func handleHitokoto(w http.ResponseWriter, r *http.Request) {	q := r.URL.Query()
	if q.Get("daily") == "1" {
		handleDaily(w, r)
		return
	}
	qs := pickQuote(parseTypes(q.Get("type")))
	if qs == nil {
		errJSON(w, http.StatusNotFound, "no_quote", "no quote for that type")
		return
	}
	// 随机一言：绝不缓存，保证每次刷新都是新句
	writeJSON(w, http.StatusOK, qs, "no-store")
}

func handleDaily(w http.ResponseWriter, r *http.Request) {
	today := time.Now().Format("2006-01-02")
	qs := dailyQuote(today)
	if qs == nil {
		errJSON(w, http.StatusNotFound, "no_quote", "quote library empty")
		return
	}
	out := map[string]any{}
	b, _ := json.Marshal(qs)
	_ = json.Unmarshal(b, &out)
	out["date"] = today
	// 当天固定，缓存 1 小时（跨零点后最多延迟 1h 切换）
	writeJSON(w, http.StatusOK, out, "public, max-age=3600")
}

func handleStats(w http.ResponseWriter, r *http.Request) {
	mu.RLock()
	nq, ni := len(quotes), len(images)
	mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]int{"quotes": nq, "images": ni}, "public, max-age=300")
}

// ---------- 静态文件 ----------

var mime = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg":  "image/svg+xml",
	".ico":  "image/x-icon",
	".png":  "image/png",
	".webp": "image/webp",
	".avif": "image/avif",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".md":   "text/markdown; charset=utf-8",
	".txt":  "text/plain; charset=utf-8",
}

func serveStatic(w http.ResponseWriter, r *http.Request) bool {
	rel := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if rel == "" || rel == "." {
		rel = "index.html"
	}
	full := path.Join(publicDi, rel)
	if !strings.HasPrefix(full, publicDi) {
		return false
	}
	st, err := os.Stat(full)
	if err != nil {
		return false
	}
	if st.IsDir() {
		full = path.Join(full, "index.html")
		if st, err = os.Stat(full); err != nil {
			return false
		}
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return false
	}
	ext := strings.ToLower(path.Ext(full))
	ct, ok := mime[ext]
	if !ok {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	switch ext {
	case ".webp", ".avif", ".jpg", ".jpeg", ".png", ".ico":
		// 图片带内容哈希，可永久缓存
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	default:
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	_, _ = w.Write(b)
	return true
}

// ---------- 入口 ----------

func main() {
	rand.New(rand.NewSource(time.Now().UnixNano()))

	port := env("PORT", "8790")
	host := env("HOST", "127.0.0.1")
	imgBase = strings.TrimRight(env("IMG_BASE_URL", "https://img.ifyi.top"), "/")
	root := env("APP_ROOT", ".")

	publicDi = path.Join(root, "public")
	dataDi := path.Join(root, "data")
	os.MkdirAll(publicDi, 0o755)
	os.MkdirAll(dataDi, 0o755)

	if err := loadImages(path.Join(dataDi, "images.json")); err != nil {
		log.Printf("images 加载失败: %v", err)
	}
	if err := loadQuotes(path.Join(dataDi, "quotes.json"), path.Join(dataDi, "quotes.remote.json")); err != nil {
		log.Printf("quotes 加载失败: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/random", handleRandom)
	// /api/image 是 /api/random?info=1 的历史别名：始终返回 JSON，绝不 302。
	// 前端取图信息走这里，若返回 302 会让 fetch().json() 直接失败。
	mux.HandleFunc("/api/image", handleImageInfo)
	mux.HandleFunc("/api/hitokoto", handleHitokoto)
	mux.HandleFunc("/api/daily", handleDaily)
	mux.HandleFunc("/api/stats", handleStats)
	mux.HandleFunc("/api/string", func(w http.ResponseWriter, r *http.Request) {
		errJSON(w, http.StatusGone, "gone", "removed; secrets are generated client-side")
	})

	// 兼容 /pc/dm /mobile/dm /pc/fjbz /mobile/fjbz
	for _, dev := range []string{"pc", "mobile"} {
		for _, g := range []string{"dm", "fjbz"} {
			d, gg := dev, g
			mux.HandleFunc("/"+d+"/"+gg, func(w http.ResponseWriter, r *http.Request) {
				q := r.URL.Query()
				q.Set("device", d)
				q.Set("genre", gg)
				r.URL.RawQuery = q.Encode()
				handleRandom(w, r)
			})
		}
	}

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte("ok\n"))
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if serveStatic(w, r) {
			return
		}
		errJSON(w, http.StatusNotFound, "not_found", r.URL.Path)
	})

	srv := &http.Server{
		Addr:              host + ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Printf("random-api(go) %s:%s  IMG=%s  images=%d quotes=%d",
		host, port, imgBase, len(images), len(quotes))
	log.Fatal(srv.ListenAndServe())
}
