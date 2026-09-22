package main

// route_registry.go 在注册真实 PocketBase handler 时同步记录产品 API 契约。
// 404/405 与跨运行面 parity 都读取同一 registry，不能再维护第二份容易漂移的手工路由表。

import (
	"net/http"
	"sort"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	pbrouter "github.com/pocketbase/pocketbase/tools/router"
)

type productRouteRegistry struct {
	methodsByPath map[string]map[string]struct{}
}

func newProductRouteRegistry() *productRouteRegistry {
	return &productRouteRegistry{methodsByPath: map[string]map[string]struct{}{}}
}

func (registry *productRouteRegistry) Record(method string, path string) {
	method = strings.ToUpper(strings.TrimSpace(method))
	path = normalizeProductRoutePath(path)
	if method == "" || path == "" {
		return
	}
	if registry.methodsByPath[path] == nil {
		registry.methodsByPath[path] = map[string]struct{}{}
	}
	registry.methodsByPath[path][method] = struct{}{}
}

func (registry *productRouteRegistry) Contracts() []apiRouteContract {
	contracts := make([]apiRouteContract, 0, len(registry.methodsByPath))
	for path, methodSet := range registry.methodsByPath {
		methods := make([]string, 0, len(methodSet))
		for method := range methodSet {
			methods = append(methods, method)
		}
		sort.Strings(methods)
		contracts = append(contracts, apiRouteContract{Path: path, Methods: methods})
	}
	sort.Slice(contracts, func(i, j int) bool { return contracts[i].Path < contracts[j].Path })
	return contracts
}

func (registry *productRouteRegistry) PathAllowsDifferentMethod(path string, method string) bool {
	// HEAD 继承 GET 是 HTTP/router 语义，不应被产品 405 包装器误判为“路径存在但方法不允许”。
	matched := false
	method = strings.ToUpper(method)
	for registeredPath, methods := range registry.methodsByPath {
		if !apiPathMatches(registeredPath, path) {
			continue
		}
		matched = true
		if _, ok := methods[method]; ok {
			return false
		}
		if method == http.MethodHead {
			if _, ok := methods[http.MethodGet]; ok {
				return false
			}
		}
	}
	return matched
}

type productRouteGroup struct {
	group    *pbrouter.RouterGroup[*core.RequestEvent]
	prefix   string
	registry *productRouteRegistry
}

func newProductRouteGroup(group *pbrouter.RouterGroup[*core.RequestEvent], prefix string, registry *productRouteRegistry) *productRouteGroup {
	return &productRouteGroup{group: group, prefix: normalizeProductRoutePath(prefix), registry: registry}
}

func (group *productRouteGroup) Group(prefix string) *productRouteGroup {
	return newProductRouteGroup(group.group.Group(prefix), joinProductRoutePath(group.prefix, prefix), group.registry)
}

func (group *productRouteGroup) Bind(middlewares ...*hook.Handler[*core.RequestEvent]) *productRouteGroup {
	group.group.Bind(middlewares...)
	return group
}

func (group *productRouteGroup) BindFunc(middlewares ...func(*core.RequestEvent) error) *productRouteGroup {
	group.group.BindFunc(middlewares...)
	return group
}

func (group *productRouteGroup) GET(path string, handler func(*core.RequestEvent) error) *pbrouter.Route[*core.RequestEvent] {
	return group.route(http.MethodGet, path, handler)
}

func (group *productRouteGroup) POST(path string, handler func(*core.RequestEvent) error) *pbrouter.Route[*core.RequestEvent] {
	return group.route(http.MethodPost, path, handler)
}

func (group *productRouteGroup) PUT(path string, handler func(*core.RequestEvent) error) *pbrouter.Route[*core.RequestEvent] {
	return group.route(http.MethodPut, path, handler)
}

func (group *productRouteGroup) PATCH(path string, handler func(*core.RequestEvent) error) *pbrouter.Route[*core.RequestEvent] {
	return group.route(http.MethodPatch, path, handler)
}

func (group *productRouteGroup) DELETE(path string, handler func(*core.RequestEvent) error) *pbrouter.Route[*core.RequestEvent] {
	return group.route(http.MethodDelete, path, handler)
}

func (group *productRouteGroup) route(method string, path string, handler func(*core.RequestEvent) error) *pbrouter.Route[*core.RequestEvent] {
	// handler 注册和契约记录必须是同一个调用；group prefix 也在这里展开，404/405 不再依赖手工路由表。
	group.registry.Record(method, joinProductRoutePath(group.prefix, path))
	return group.group.Route(method, path, handler)
}

func (group *productRouteGroup) Raw() *pbrouter.RouterGroup[*core.RequestEvent] {
	return group.group
}

func joinProductRoutePath(prefix string, path string) string {
	if prefix == "" {
		return normalizeProductRoutePath(path)
	}
	if path == "" || path == "/" {
		return normalizeProductRoutePath(prefix)
	}
	return normalizeProductRoutePath(strings.TrimRight(prefix, "/") + "/" + strings.TrimLeft(path, "/"))
}

func normalizeProductRoutePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" || path == "/" {
		return path
	}
	return "/" + strings.Trim(path, "/")
}
